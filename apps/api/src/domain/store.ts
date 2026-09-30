import { newId } from "@intyr/core";

export interface TripRow {
  id: string;
  network: string;
  owner: string;
  state: string;
  version: number;
  currency: string | null;
  total_minor: number | null;
  readiness: number | null;
  doc_json: string;
  operation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManifestRow {
  id: string;
  trip_id: string | null;
  kind: "PLAN" | "COMMIT" | "TRANSACTION";
  hash: string;
  status: "ACTIVE" | "SUPERSEDED" | "EXPIRED" | "REVOKED";
  expires_at: string | null;
  network: string;
  signed_json: string;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  trip_id: string;
  component_id: string;
  action: "COMMIT" | "CANCEL" | "REPLACE";
  attempt_no: number;
  state: "STARTED" | "RESPONDED" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  request_hash: string;
  response_hash: string | null;
  idempotency_ref: string;
  detail_json: string | null;
  created_at: string;
  updated_at: string;
}

export class VersionConflictError extends Error {
  constructor(tripId: string) {
    super(`trip ${tripId} was changed by another writer`);
    this.name = "VersionConflictError";
  }
}

export class TripStore {
  constructor(private db: D1Database) {}

  async createTrip(input: { id?: string; network: string; owner: string; state: string; currency?: string; total_minor?: number; readiness?: number; doc: unknown; operation_id?: string; now: string }): Promise<TripRow> {
    const id = input.id ?? newId("trp");
    await this.db
      .prepare(
        `INSERT INTO trips (id, network, owner, state, version, currency, total_minor, readiness, doc_json, operation_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,1,?5,?6,?7,?8,?9,?10,?10)`,
      )
      .bind(id, input.network, input.owner, input.state, input.currency ?? null, input.total_minor ?? null, input.readiness ?? null, JSON.stringify(input.doc), input.operation_id ?? null, input.now)
      .run();
    return (await this.getTrip(id))!;
  }

  getTrip(id: string): Promise<TripRow | null> {
    return this.db.prepare("SELECT * FROM trips WHERE id = ?1").bind(id).first<TripRow>();
  }

  async listTripsByState(states: string[], limit = 25): Promise<TripRow[]> {
    const ph = states.map((_, i) => `?${i + 1}`).join(",");
    const r = await this.db
      .prepare(`SELECT * FROM trips WHERE state IN (${ph}) ORDER BY updated_at LIMIT ?${states.length + 1}`)
      .bind(...states, limit)
      .all<TripRow>();
    return r.results ?? [];
  }

  async listTrips(owner: string, limit = 50): Promise<TripRow[]> {
    const r = await this.db.prepare("SELECT * FROM trips WHERE owner = ?1 ORDER BY created_at DESC LIMIT ?2").bind(owner, limit).all<TripRow>();
    return r.results ?? [];
  }

  /** Compare-and-set on the trip version so a stale worker can never overwrite newer state. */
  async updateTrip(
    id: string,
    expectedVersion: number,
    patch: { state?: string; currency?: string; total_minor?: number; readiness?: number; doc?: unknown },
    now: string,
  ): Promise<TripRow> {
    const res = await this.db
      .prepare(
        `UPDATE trips SET state = COALESCE(?1, state), currency = COALESCE(?2, currency), total_minor = COALESCE(?3, total_minor),
           readiness = COALESCE(?4, readiness), doc_json = COALESCE(?5, doc_json), version = version + 1, updated_at = ?6
         WHERE id = ?7 AND version = ?8`,
      )
      .bind(patch.state ?? null, patch.currency ?? null, patch.total_minor ?? null, patch.readiness ?? null, patch.doc === undefined ? null : JSON.stringify(patch.doc), now, id, expectedVersion)
      .run();
    if ((res.meta?.changes ?? 0) === 0) throw new VersionConflictError(id);
    return (await this.getTrip(id))!;
  }

  async putManifest(row: Omit<ManifestRow, "created_at" | "updated_at"> & { now: string }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO manifests (id, trip_id, kind, hash, status, expires_at, network, signed_json, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`,
      )
      .bind(row.id, row.trip_id, row.kind, row.hash, row.status, row.expires_at, row.network, row.signed_json, row.now)
      .run();
  }

  getManifest(id: string): Promise<ManifestRow | null> {
    return this.db.prepare("SELECT * FROM manifests WHERE id = ?1").bind(id).first<ManifestRow>();
  }

  getActiveManifest(tripId: string): Promise<ManifestRow | null> {
    return this.db
      .prepare("SELECT * FROM manifests WHERE trip_id = ?1 AND kind = 'COMMIT' AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1")
      .bind(tripId)
      .first<ManifestRow>();
  }

  async setManifestStatus(id: string, status: ManifestRow["status"], now: string): Promise<void> {
    await this.db.prepare("UPDATE manifests SET status = ?1, updated_at = ?2 WHERE id = ?3").bind(status, now, id).run();
  }

  async putDecision(tripId: string | null, decision: { decision_id: string; gate: string; outcome: string; decision_hash: string }, now: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO decisions (id, trip_id, gate, outcome, decision_hash, decision_json, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
      .bind(decision.decision_id, tripId, decision.gate, decision.outcome, decision.decision_hash, JSON.stringify(decision), now)
      .run();
  }

  async listDecisions(tripId: string): Promise<unknown[]> {
    const r = await this.db.prepare("SELECT decision_json FROM decisions WHERE trip_id = ?1 ORDER BY created_at, rowid").bind(tripId).all<{ decision_json: string }>();
    return (r.results ?? []).map((x) => JSON.parse(x.decision_json));
  }

  /**
   * Write-ahead record for a supplier write. Returns `created: false` when an attempt already exists,
   * in which case the caller must reconcile and never call the supplier again.
   */
  async startAttempt(input: { trip_id: string; component_id: string; action: AttemptRow["action"]; request_hash: string; idempotency_ref: string; now: string }): Promise<{ created: boolean; attempt: AttemptRow }> {
    const id = newId("att");
    const prior = await this.db
      .prepare("SELECT MAX(attempt_no) AS n FROM commit_attempts WHERE trip_id = ?1 AND component_id = ?2 AND action = ?3")
      .bind(input.trip_id, input.component_id, input.action)
      .first<{ n: number | null }>();
    const attemptNo = input.action === "COMMIT" ? 1 : (prior?.n ?? 0) + 1;
    const res = await this.db
      .prepare(
        `INSERT INTO commit_attempts (id, trip_id, component_id, action, attempt_no, state, request_hash, idempotency_ref, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,'STARTED',?6,?7,?8,?8) ON CONFLICT DO NOTHING`,
      )
      .bind(id, input.trip_id, input.component_id, input.action, attemptNo, input.request_hash, input.idempotency_ref, input.now)
      .run();
    const created = (res.meta?.changes ?? 0) > 0;
    const attempt = (await this.db
      .prepare("SELECT * FROM commit_attempts WHERE trip_id = ?1 AND component_id = ?2 AND action = ?3 ORDER BY attempt_no DESC LIMIT 1")
      .bind(input.trip_id, input.component_id, input.action)
      .first<AttemptRow>())!;
    return { created, attempt };
  }

  async advanceAttempt(id: string, from: AttemptRow["state"][], to: AttemptRow["state"], patch: { response_hash?: string; detail?: unknown }, now: string): Promise<boolean> {
    const ph = from.map((_, i) => `?${i + 5}`).join(",");
    const res = await this.db
      .prepare(
        `UPDATE commit_attempts SET state = ?1, response_hash = COALESCE(?2, response_hash), detail_json = COALESCE(?3, detail_json), updated_at = ?4
         WHERE id = ?${from.length + 5} AND state IN (${ph})`,
      )
      .bind(to, patch.response_hash ?? null, patch.detail === undefined ? null : JSON.stringify(patch.detail), now, ...from, id)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async listAttempts(tripId: string): Promise<AttemptRow[]> {
    const r = await this.db.prepare("SELECT * FROM commit_attempts WHERE trip_id = ?1 ORDER BY created_at, attempt_no").bind(tripId).all<AttemptRow>();
    return r.results ?? [];
  }

  async putApproval(a: { trip_id: string; manifest_hash: string; decision: "APPROVE" | "REJECT"; actor: string; note?: string; now: string }): Promise<string> {
    const id = newId("evt");
    await this.db.prepare("INSERT INTO approvals (id, trip_id, manifest_hash, decision, actor, note, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(id, a.trip_id, a.manifest_hash, a.decision, a.actor, a.note ?? null, a.now).run();
    return id;
  }

  latestApproval(tripId: string): Promise<{ manifest_hash: string; decision: string } | null> {
    return this.db.prepare("SELECT manifest_hash, decision FROM approvals WHERE trip_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(tripId).first();
  }

  /** Records the intent to anchor before any chain call, so a failure before the transaction exists is still retried. */
  async queueAnchor(a: { manifest_id: string; network: string; mode: string; now: string }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO anchors (manifest_id, network, mode, txid, state, created_at, updated_at) VALUES (?1,?2,?3,NULL,'QUEUED',?4,?4)
         ON CONFLICT(manifest_id) DO UPDATE SET updated_at = excluded.updated_at WHERE anchors.state = 'QUEUED'`,
      )
      .bind(a.manifest_id, a.network, a.mode, a.now)
      .run();
  }

  /** Puts an anchor whose transaction never reached the network back in the queue. */
  async requeueAnchor(manifestId: string, now: string): Promise<void> {
    await this.db.prepare("UPDATE anchors SET state = 'QUEUED', txid = NULL, updated_at = ?1 WHERE manifest_id = ?2").bind(now, manifestId).run();
  }

  async listQueuedAnchors(notTouchedSince: string, limit = 10): Promise<Array<{ manifest_id: string; network: string; created_at: string }>> {
    const r = await this.db.prepare("SELECT manifest_id, network, created_at FROM anchors WHERE state = 'QUEUED' AND updated_at <= ?1 ORDER BY updated_at LIMIT ?2").bind(notTouchedSince, limit).all<{ manifest_id: string; network: string; created_at: string }>();
    return r.results ?? [];
  }

  async putAnchor(a: { manifest_id: string; network: string; mode: string; txid: string; state: string; now: string }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO anchors (manifest_id, network, mode, txid, state, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(manifest_id) DO UPDATE SET txid = excluded.txid, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(a.manifest_id, a.network, a.mode, a.txid, a.state, a.now)
      .run();
  }

  async updateAnchor(manifestId: string, patch: { state: string; round?: number; error?: string; now: string }): Promise<void> {
    await this.db
      .prepare("UPDATE anchors SET state = ?1, round = COALESCE(?2, round), error = COALESCE(?3, error), updated_at = ?4 WHERE manifest_id = ?5")
      .bind(patch.state, patch.round ?? null, patch.error ?? null, patch.now, manifestId)
      .run();
  }

  getAnchor(manifestId: string): Promise<{ manifest_id: string; network: string; mode: string; txid: string | null; state: string; round: number | null; error: string | null } | null> {
    return this.db.prepare("SELECT * FROM anchors WHERE manifest_id = ?1").bind(manifestId).first();
  }

  getAnchorByTxid(txid: string): Promise<{ manifest_id: string; network: string } | null> {
    return this.db.prepare("SELECT manifest_id, network FROM anchors WHERE txid = ?1").bind(txid).first();
  }

  async listPendingAnchors(limit = 20): Promise<Array<{ manifest_id: string; network: string; txid: string; created_at: string }>> {
    const r = await this.db.prepare("SELECT manifest_id, network, txid, created_at FROM anchors WHERE state IN ('SUBMITTED','PENDING') AND txid IS NOT NULL ORDER BY updated_at LIMIT ?1").bind(limit).all<{ manifest_id: string; network: string; txid: string; created_at: string }>();
    return r.results ?? [];
  }

  async createSandboxSession(now: string, ttlMs = 24 * 3600_000): Promise<{ id: string; expires_at: string }> {
    const id = newId("evt").replace("evt_", "sbx_");
    const expires = new Date(Date.parse(now) + ttlMs).toISOString();
    await this.db.prepare("INSERT INTO sandbox_sessions (id, created_at, expires_at, last_seen_at) VALUES (?1,?2,?3,?2)").bind(id, now, expires).run();
    return { id, expires_at: expires };
  }

  getSandboxSession(id: string): Promise<{ id: string; expires_at: string } | null> {
    return this.db.prepare("SELECT id, expires_at FROM sandbox_sessions WHERE id = ?1").bind(id).first();
  }
}
