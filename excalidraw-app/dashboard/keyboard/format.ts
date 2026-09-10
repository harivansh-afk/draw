import { isDarwin } from "@excalidraw/common";

import type { Chord } from "./chord";

const NAMES: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "↵",
  escape: "esc",
  space: "space",
  backspace: "⌫",
};

/**
 * Human form of a key sequence for `kbd` chips: "mod+k" becomes "cmd k" on
 * macOS and "ctrl k" elsewhere; a chord sequence stays "g t". Modifiers are
 * spelled out because the dashboard font has no ⌘ glyph.
 */
export const formatKeys = (
  keys: readonly Chord[],
  { mac = isDarwin }: { mac?: boolean } = {},
): string =>
  keys
    .map((chord) =>
      chord
        .split("+")
        .map((part) => {
          if (part === "mod") {
            return mac ? "cmd" : "ctrl";
          }
          return NAMES[part] ?? part;
        })
        .join(" "),
    )
    .join(" ");
