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

