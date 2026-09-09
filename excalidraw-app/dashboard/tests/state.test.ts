import { describe, expect, it } from "vitest";

import {
  filterScenes,
  initials,
  nextUntitledName,
  relativeTime,
  sortScenes,
  stripExcalidrawExtension,
} from "../state";

import type { SceneMeta } from "../../data/api";

const scene = (overrides: Partial<SceneMeta>): SceneMeta => ({
  id: "id",
  name: "Untitled",
  collectionId: null,
  shareMode: "private",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
  hasThumbnail: false,
  ...overrides,
});

describe("sortScenes", () => {
  const scenes = [
    scene({
      id: "a",
      name: "banana",
      updatedAt: "2026-02-01T00:00:00Z",
      createdAt: "2026-01-03T00:00:00Z",
    }),
    scene({
      id: "b",
      name: "Apple",
      updatedAt: "2026-03-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    }),
    scene({
      id: "c",
      name: "cherry 10",
      updatedAt: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-02T00:00:00Z",
    }),
    scene({
      id: "d",
      name: "cherry 2",
      updatedAt: "2026-01-02T00:00:00Z",
      createdAt: "2026-01-04T00:00:00Z",
    }),
  ];

  it("sorts by last edited, newest first", () => {
    expect(sortScenes(scenes, "updated").map((s) => s.id)).toEqual([
      "b",
      "a",
      "d",
      "c",
    ]);
  });

  it("sorts by name, case-insensitive and numeric-aware", () => {
    expect(sortScenes(scenes, "name").map((s) => s.id)).toEqual([
      "b",
      "a",
      "d",
      "c",
    ]);
  });

  it("sorts by created, newest first", () => {
    expect(sortScenes(scenes, "created").map((s) => s.id)).toEqual([
      "d",
      "a",
      "c",
      "b",
    ]);
  });

  it("does not mutate the input", () => {
    const copy = [...scenes];
    sortScenes(scenes, "name");
    expect(scenes).toEqual(copy);
  });
});

describe("filterScenes", () => {
  const scenes = [
    scene({ id: "a", name: "System architecture" }),
    scene({ id: "b", name: "Auth flow" }),
    scene({ id: "c", name: "Kitchen remodel" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterScenes(scenes, "")).toHaveLength(3);
    expect(filterScenes(scenes, "   ")).toHaveLength(3);
  });

  it("matches case-insensitively on every term", () => {
    expect(filterScenes(scenes, "AUTH").map((s) => s.id)).toEqual(["b"]);
    expect(filterScenes(scenes, "sys arch").map((s) => s.id)).toEqual(["a"]);
    expect(filterScenes(scenes, "sys flow")).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("uses the Excalidraw+ wording", () => {
    expect(relativeTime(at(10_000), now)).toBe("just now");
    expect(relativeTime(at(MIN), now)).toBe("a minute ago");
    expect(relativeTime(at(5 * MIN), now)).toBe("5 minutes ago");
    expect(relativeTime(at(HOUR), now)).toBe("an hour ago");
    expect(relativeTime(at(3 * HOUR), now)).toBe("3 hours ago");
    expect(relativeTime(at(DAY), now)).toBe("a day ago");
    expect(relativeTime(at(17 * DAY), now)).toBe("17 days ago");
    expect(relativeTime(at(45 * DAY), now)).toBe("a month ago");
    expect(relativeTime(at(100 * DAY), now)).toBe("3 months ago");
    expect(relativeTime(at(400 * DAY), now)).toBe("a year ago");
    expect(relativeTime(at(800 * DAY), now)).toBe("2 years ago");
  });

  it("never reports the future and tolerates garbage", () => {
    expect(relativeTime(new Date(now + HOUR).toISOString(), now)).toBe(
      "just now",
    );
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("naming helpers", () => {
  it("derives initials from a name or the email", () => {
    expect(initials("Harivansh Rathi", "x@y.z")).toBe("HR");
    expect(initials("", "hari@example.com")).toBe("HA");
    expect(initials("Hari", "")).toBe("HA");
  });

  it("picks the next free Untitled name", () => {
    expect(nextUntitledName([])).toBe("Untitled");
    expect(nextUntitledName([scene({ name: "Untitled" })])).toBe("Untitled 2");
    expect(
      nextUntitledName([
        scene({ name: "Untitled" }),
        scene({ name: "Untitled 2" }),
      ]),
    ).toBe("Untitled 3");
  });

  it("strips the .excalidraw extension for imported names", () => {
    expect(stripExcalidrawExtension("diagram.excalidraw")).toBe("diagram");
    expect(stripExcalidrawExtension("diagram.excalidraw.json")).toBe("diagram");
    expect(stripExcalidrawExtension("plain")).toBe("plain");
    expect(stripExcalidrawExtension(".excalidraw")).toBe("Untitled");
  });
});
