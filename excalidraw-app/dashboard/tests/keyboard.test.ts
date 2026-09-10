import { describe, expect, it, vi } from "vitest";

import { chordFromEvent, isTypingTarget } from "../keyboard/chord";
import { createKeyEngine } from "../keyboard/engine";
import { formatKeys } from "../keyboard/format";
import { fuzzyRank, fuzzyScore } from "../keyboard/fuzzy";
import { moveIndex } from "../keyboard/grid";
import { createKeymap } from "../keyboard/keymap";

const key = (
  key: string,
  mods: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  > = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("chordFromEvent", () => {
  it("keeps the produced character for plain keys", () => {
    expect(chordFromEvent(key("j"))).toBe("j");
    expect(chordFromEvent(key("G", { shiftKey: true }))).toBe("G");
    expect(chordFromEvent(key("?", { shiftKey: true }))).toBe("?");
    expect(chordFromEvent(key("/"))).toBe("/");
  });

  it("names special keys and keeps shift on them", () => {
    expect(chordFromEvent(key("Escape"))).toBe("escape");
    expect(chordFromEvent(key("Enter", { shiftKey: true }))).toBe(
      "shift+enter",
    );
    expect(chordFromEvent(key("ArrowDown"))).toBe("down");
  });

  it("maps mod to the platform's primary modifier", () => {
    expect(chordFromEvent(key("k", { metaKey: true }), { mac: true })).toBe(
      "mod+k",
    );
    expect(chordFromEvent(key("k", { ctrlKey: true }), { mac: false })).toBe(
      "mod+k",
    );
    expect(chordFromEvent(key("k", { ctrlKey: true }), { mac: true })).toBe(
      "ctrl+k",
    );
    expect(
      chordFromEvent(key("P", { metaKey: true, shiftKey: true }), {
        mac: true,
      }),
    ).toBe("mod+shift+p");
  });

  it("ignores lone modifiers", () => {
    expect(chordFromEvent(key("Shift", { shiftKey: true }))).toBeNull();
    expect(chordFromEvent(key("Meta", { metaKey: true }))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("covers text-like inputs and contenteditable, not buttons", () => {
    const search = document.createElement("input");
    search.type = "search";
    const email = document.createElement("input");
    email.type = "email";
    const button = document.createElement("button");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(search, email, button, editable);
    expect(isTypingTarget(search)).toBe(true);
    expect(isTypingTarget(email)).toBe(true);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("createKeymap", () => {
  const keymap = createKeymap([
    { keys: ["j"], command: "down" },
    { keys: ["g", "g"], command: "first" },
    { keys: ["g", "t"], command: "trash" },
    { keys: ["d"], command: "peek" },
    { keys: ["d", "d"], command: "delete" },
  ]);

  it("resolves exact, prefix and miss", () => {
    expect(keymap.resolve(["j"])).toEqual({ kind: "exact", command: "down" });
    expect(keymap.resolve(["g"])).toEqual({ kind: "prefix", command: null });
    expect(keymap.resolve(["g", "t"])).toEqual({
      kind: "exact",
      command: "trash",
    });
    expect(keymap.resolve(["g", "x"])).toEqual({ kind: "none" });
    expect(keymap.resolve(["x"])).toEqual({ kind: "none" });
  });

  it("reports a key that is both a command and a prefix", () => {
    expect(keymap.resolve(["d"])).toEqual({ kind: "prefix", command: "peek" });
  });

  it("rejects conflicting bindings", () => {
    expect(() =>
      createKeymap([
        { keys: ["a"], command: "one" },
        { keys: ["a"], command: "two" },
      ]),
    ).toThrow(/bound to both/);
  });
});

describe("createKeyEngine", () => {
  const press = (
    engine: ReturnType<typeof createKeyEngine>,
    k: string,
    mods: Partial<
      Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
    > = {},
    target: EventTarget = document.body,
  ) => {
    const event = new KeyboardEvent("keydown", {
      key: k,
      ...mods,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: target });
    return { handled: engine.handle(event), event };
  };

  const build = (
    overrides: Partial<Parameters<typeof createKeyEngine>[0]> = {},
  ) => {
    vi.useFakeTimers();
    const ran: string[] = [];
    const engine = createKeyEngine({
      keymap: createKeymap([
        { keys: ["j"], command: "down" },
        { keys: ["g", "g"], command: "first" },
        { keys: ["g", "t"], command: "trash" },
        { keys: ["d"], command: "peek" },
        { keys: ["d", "d"], command: "delete" },
        { keys: ["escape"], command: "escape" },
        { keys: ["mod+k"], command: "palette" },
      ]),
      run: (command) => {
        ran.push(command);
        return true;
      },
      passthrough: ["escape", "mod+k"],
      timeoutMs: 500,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      ...overrides,
    });
    return { engine, ran };
  };

  it("runs single keys and sequences, preventing default", () => {
    const { engine, ran } = build();
    const first = press(engine, "j");
    expect(first.handled).toBe(true);
    expect(first.event.defaultPrevented).toBe(true);
    press(engine, "g");
    expect(engine.pending()).toEqual(["g"]);
    press(engine, "t");
    expect(ran).toEqual(["down", "trash"]);
    expect(engine.pending()).toEqual([]);
  });

  it("restarts a miss with the current key", () => {
    const { engine, ran } = build();
    press(engine, "g");
    const miss = press(engine, "j");
    expect(miss.handled).toBe(true);
    expect(ran).toEqual(["down"]);
  });

  it("times a prefix out, running its own command when it has one", () => {
    const { engine, ran } = build();
    press(engine, "g");
    vi.advanceTimersByTime(600);
    expect(engine.pending()).toEqual([]);
    expect(ran).toEqual([]);
    press(engine, "d");
    vi.advanceTimersByTime(600);
    expect(ran).toEqual(["peek"]);
    press(engine, "d");
    press(engine, "d");
    expect(ran).toEqual(["peek", "delete"]);
  });

  it("leaves typing alone except for passthrough chords", () => {
    const { engine, ran } = build();
    const input = document.createElement("input");
    input.type = "search";
    document.body.append(input);
    expect(press(engine, "j", {}, input).handled).toBe(false);
    expect(
      press(engine, "k", { metaKey: true, ctrlKey: true }, input).handled,
    ).toBe(true);
    expect(press(engine, "Escape", {}, input).handled).toBe(true);
    expect(ran).toEqual(["palette", "escape"]);
  });

  it("treats disabled commands as unbound and honours suspension", () => {
    const { engine, ran } = build({
      isEnabled: (command) => command !== "down",
    });
    expect(press(engine, "j").handled).toBe(false);
    expect(ran).toEqual([]);
    const suspended = build({ isSuspended: () => true });
    expect(press(suspended.engine, "j").handled).toBe(false);
  });
});

describe("moveIndex", () => {
  // 7 cards, 3 columns:  0 1 2 / 3 4 5 / 6
  it("moves within rows and columns without wrapping", () => {
    expect(moveIndex(null, 7, 3, "down")).toBe(0);
    expect(moveIndex(0, 7, 3, "right")).toBe(1);
    expect(moveIndex(2, 7, 3, "right")).toBe(2);
    expect(moveIndex(3, 7, 3, "left")).toBe(3);
    expect(moveIndex(1, 7, 3, "down")).toBe(4);
    expect(moveIndex(4, 7, 3, "down")).toBe(6);
    expect(moveIndex(6, 7, 3, "down")).toBe(6);
    expect(moveIndex(6, 7, 3, "up")).toBe(3);
    expect(moveIndex(1, 7, 3, "up")).toBe(1);
    expect(moveIndex(3, 0, 3, "up")).toBeNull();
  });
});

describe("fuzzy", () => {
  it("requires every character in order and prefers word starts", () => {
    expect(fuzzyScore("xyz", "move to trash")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    const ranked = fuzzyRank(
      ["import scenes", "move to trash", "empty trash"],
      "mt",
      (s) => s,
    );
    expect(ranked).toEqual(["move to trash", "empty trash", "import scenes"]);
    expect(fuzzyRank(["a", "b"], "zz", (s) => s)).toEqual([]);
  });
});

describe("formatKeys", () => {
  it("spells modifiers per platform and keeps sequences", () => {
    expect(formatKeys(["mod+k"], { mac: true })).toBe("cmd k");
    expect(formatKeys(["mod+k"], { mac: false })).toBe("ctrl k");
    expect(formatKeys(["g", "t"])).toBe("g t");
    expect(formatKeys(["shift+enter"])).toBe("shift ↵");
  });
});
