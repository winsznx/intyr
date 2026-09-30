import { COMPONENT_TYPE } from "./labels";
import type { Trip } from "./types";

export function componentNames(list: Trip["components"]): string {
  const words = list.map((c) => COMPONENT_TYPE[c.type] ?? c.type);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** One sentence built only from component states, so it reads in five seconds and never claims more than the record. */
export function recoverySentence(trip: Trip): string {
  const failed = trip.components.filter((c) => c.state === "COMMIT_FAILED" || c.state === "UNAVAILABLE");
  const cancelled = trip.components.filter((c) => c.state === "CANCELLED");
  const replaced = trip.components.filter((c) => c.state === "REPLACED");
  const booked = trip.components.filter((c) => c.state === "CONFIRMED");
  const parts: string[] = [];
  if (failed.length) parts.push(`${sentenceStart(componentNames(failed))} failed at commit.`);
  if (cancelled.length) parts.push(`${sentenceStart(componentNames(cancelled))} cancelled inside the limit.`);
  if (replaced.length) parts.push(`${sentenceStart(componentNames(replaced))} replaced.`);
  parts.push(booked.length ? `Still booked: ${componentNames(booked).toLowerCase()}.` : "Nothing left booked.");
  return parts.join(" ");
}


export type ApprovalState = "NEEDED" | "GIVEN" | "NONE";

/**
 * The trip document keeps approval_required after a person approves, so the state comes from next_actions:
 * approval is needed while COMMIT is blocked for APPROVAL_REQUIRED or a REQUEST_APPROVAL action is open.
 */
export function approvalState(trip: Trip): ApprovalState {
  const actions = trip.next_actions ?? [];
  const commit = actions.find((a) => a.action === "COMMIT");
  const requested = actions.some((a) => a.action === "REQUEST_APPROVAL" && a.allowed);
  if (requested || (commit && !commit.allowed && commit.reason === "APPROVAL_REQUIRED")) return "NEEDED";
  if (trip.state === "MANUAL_REVIEW" && !commit?.allowed) return "NEEDED";
  if (trip.approval?.required && commit?.allowed) return "GIVEN";
  return "NONE";
}
