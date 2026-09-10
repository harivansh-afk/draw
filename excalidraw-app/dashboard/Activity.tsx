import React from "react";

import { editorPath, navigate } from "./router";
import { relativeTime } from "./state";

import type { Activity } from "../data/api";

const DAY = 86_400_000;

/** "today", "yesterday", a weekday within the week, else "12 aug". */
export const dayLabel = (iso: string, now: number): string => {
  const then = new Date(iso);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((start.getTime() - startOfDay(then)) / DAY);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return then.toLocaleDateString(undefined, { weekday: "long" });
  }
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

const startOfDay = (date: Date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

/** The verb phrase before the scene name, and any trailing detail after it. */
export const describe = (
  entry: Activity,
): { verb: string; detail: string | null } => {
  switch (entry.kind) {
    case "created":
      return { verb: "Created", detail: null };
    case "edited":
      return { verb: "Edited", detail: null };
    case "renamed":
      return {
        verb: "Renamed",
        detail: entry.detail ? `from “${entry.detail}”` : null,
      };
    case "moved":
      return {
        verb: "Moved",
        detail: entry.detail ? `to ${entry.detail}` : "out of its collection",
      };
    case "shared":
      return {
        verb:
          entry.detail === "private"
            ? "Made private"
            : entry.detail === "edit"
            ? "Shared for editing"
            : "Shared for viewing",
        detail: null,
      };
    case "duplicated":
      return {
        verb: "Duplicated",
        detail: entry.detail ? `from “${entry.detail}”` : null,
      };
    case "trashed":
      return { verb: "Moved to trash", detail: null };
    case "restored":
      return { verb: "Restored", detail: null };
    case "deleted":
      return { verb: "Deleted", detail: null };
    default:
      return { verb: entry.kind, detail: null };
  }
};

export const actorLabel = (entry: Activity, userId: string): string | null => {
  if (entry.actorId === userId) {
    return null;
  }
  if (!entry.actorId) {
    return "someone with the link";
  }
  return entry.actorName || "a collaborator";
};

export const ActivityRail = ({
  entries,
  userId,
  now,
}: {
  entries: Activity[] | null;
  userId: string;
  now: number;
}) => {
  const groups: { label: string; entries: Activity[] }[] = [];
  for (const entry of entries ?? []) {
    const label = dayLabel(entry.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.entries.push(entry);
    } else {
      groups.push({ label, entries: [entry] });
    }
  }
  return (
    <aside className="dash-rail" aria-label="Activity">
      <h2 className="dash-rail__title">Activity</h2>
      {entries === null ? null : entries.length === 0 ? (
        <p className="dash-rail__empty">Nothing yet.</p>
      ) : (
        groups.map((group) => (
          <section key={group.label} className="dash-rail__day">
            <h3 className="dash-rail__day-label">{group.label}</h3>
            <ol className="dash-rail__list">
              {group.entries.map((entry) => (
                <ActivityRow
                  key={entry.id}
                  entry={entry}
                  userId={userId}
                  now={now}
                  today={group.label === "Today"}
                />
              ))}
            </ol>
          </section>
        ))
      )}
    </aside>
  );
};

const ActivityRow = ({
  entry,
  userId,
  now,
  today,
}: {
  entry: Activity;
  userId: string;
  now: number;
  today: boolean;
}) => {
  const { verb, detail } = describe(entry);
  const actor = actorLabel(entry, userId);
  return (
    <li className="dash-rail__entry">
      <div className="dash-rail__line">
        <span className="dash-rail__verb">{verb} </span>
        <SceneRef entry={entry} />
        {detail && <span className="dash-rail__detail"> {detail}</span>}
      </div>
      <div className="dash-rail__meta">
        {today ? relativeTime(entry.at, now) : clock(entry.at)}
        {actor && ` · by ${actor}`}
      </div>
    </li>
  );
};

const SceneRef = ({ entry }: { entry: Activity }) => {
  if (!entry.sceneId || entry.sceneState === "gone") {
    return <span className="dash-rail__scene--gone">{entry.sceneName}</span>;
  }
  if (entry.sceneState === "trash") {
    return (
      <a
        className="dash-rail__scene"
        href="/trash"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.button !== 0) {
            return;
          }
          event.preventDefault();
          navigate({ view: "trash" });
        }}
      >
        {entry.sceneName}
      </a>
    );
  }
  return (
    <a className="dash-rail__scene" href={editorPath(entry.sceneId)}>
      {entry.sceneName}
    </a>
  );
};
