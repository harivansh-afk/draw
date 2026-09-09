import type { SceneMeta } from "../data/api";

export type SortKey = "updated" | "name" | "created";

export const SORT_LABELS: Record<SortKey, string> = {
  updated: "Last edited",
  name: "Name",
  created: "Created",
};

export const sortScenes = (
  scenes: readonly SceneMeta[],
  sort: SortKey,
): SceneMeta[] => {
  const list = [...scenes];
  switch (sort) {
    case "name":
      list.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      );
      break;
    case "created":
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      break;
    default:
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return list;
};

export const filterScenes = (
  scenes: readonly SceneMeta[],
  query: string,
): SceneMeta[] => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...scenes];
  }
  const terms = q.split(/\s+/);
  return scenes.filter((scene) => {
    const name = scene.name.toLowerCase();
    return terms.every((term) => name.includes(term));
  });
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const plural = (n: number, unit: string, one: string) =>
  n === 1 ? `${one} ago` : `${n} ${unit}s ago`;

/**
 * Excalidraw+ style: "just now", "5 minutes ago", "an hour ago", "17 days
 * ago", "a month ago", "a year ago". Deterministic given `now`.
 */
export const relativeTime = (iso: string, now = Date.now()): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diff = Math.max(0, now - then);
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    return plural(Math.floor(diff / MINUTE), "minute", "a minute");
  }
  if (diff < DAY) {
    return plural(Math.floor(diff / HOUR), "hour", "an hour");
  }
  if (diff < MONTH) {
    return plural(Math.floor(diff / DAY), "day", "a day");
  }
  if (diff < YEAR) {
    return plural(Math.floor(diff / MONTH), "month", "a month");
  }
  return plural(Math.floor(diff / YEAR), "year", "a year");
};

export const initials = (name: string, email: string): string => {
  const source = name.trim() || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
};

export const nextUntitledName = (scenes: readonly SceneMeta[]): string => {
  const taken = new Set(scenes.map((s) => s.name));
  if (!taken.has("Untitled")) {
    return "Untitled";
  }
  let n = 2;
  while (taken.has(`Untitled ${n}`)) {
    n++;
  }
  return `Untitled ${n}`;
};

export const stripExcalidrawExtension = (filename: string): string =>
  filename.replace(/\.excalidraw(\.json)?$/i, "").trim() || "Untitled";
