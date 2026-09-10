import { isDarwin, isWritableElement } from "@excalidraw/common";

/**
 * A chord is one key press written as text: `k`, `G`, `?`, `enter`,
 * `mod+k`, `mod+shift+p`, `shift+enter`. Printable keys keep the character
 * the keyboard produced, so `G` already means shift+g and `?` works on any
 * layout that has one. `mod` is ⌘ on macOS and ctrl elsewhere, the same rule
 * the editor uses through `KEYS.CTRL_OR_CMD`.
 */
export type Chord = string;

const NAMED_KEYS: Record<string, string> = {
  " ": "space",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Dead",
  "Unidentified",
  "AltGraph",
]);

export type ChordSource = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

export const chordFromEvent = (
  event: ChordSource,
  { mac = isDarwin }: { mac?: boolean } = {},
): Chord | null => {
  if (!event.key || MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  const mod = mac ? event.metaKey : event.ctrlKey;
  const ctrl = mac ? event.ctrlKey : false;
  const alt = event.altKey;
  const named = NAMED_KEYS[event.key];
  const printable = !named && event.key.length === 1;

  if (printable && !mod && !ctrl && !alt) {
    return event.key;
  }
  const parts: string[] = [];
  if (mod) {
    parts.push("mod");
  }
  if (ctrl) {
    parts.push("ctrl");
  }
  if (alt) {
    parts.push("alt");
  }
  if (event.shiftKey && (named || mod || ctrl || alt)) {
    parts.push("shift");
  }
  parts.push(named ?? event.key.toLowerCase());
  return parts.join("+");
};

/**
 * True when the key press belongs to a text field, so single-key bindings
 * must not fire. Upstream's guard covers the editor's inputs; the dashboard
 * adds the remaining text-like input types and contenteditable surfaces.
 */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }
  if (isWritableElement(target)) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return ![
      "button",
      "checkbox",
      "radio",
      "submit",
      "reset",
      "file",
      "range",
      "color",
    ].includes(target.type);
  }
  const editable = target.getAttribute("contenteditable");
  return (
    editable === "" || editable === "true" || editable === "plaintext-only"
  );
};
