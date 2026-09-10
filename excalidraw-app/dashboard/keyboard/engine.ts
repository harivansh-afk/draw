import { chordFromEvent, isTypingTarget } from "./chord";

import type { Chord } from "./chord";
import type { Keymap } from "./keymap";

export type KeyEngineOptions = {
  keymap: Keymap;
  /** Runs a resolved command. Return false to let the browser keep the key. */
  run: (command: string, event: KeyboardEvent) => boolean;
  /** Commands whose `when` is false behave as unbound. */
  isEnabled?: (command: string) => boolean;
  /** Chords that fire even while typing in a field (escape, the palette). */
  passthrough?: Chord[];
  /** Skip everything, e.g. while a menu, modal or the palette owns the keys. */
  isSuspended?: () => boolean;
  /** How long a prefix waits for its next key before giving up. */
  timeoutMs?: number;
  onPendingChange?: (pending: Chord[]) => void;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
};

export type KeyEngine = {
  handle: (event: KeyboardEvent) => boolean;
  reset: () => void;
  pending: () => Chord[];
};

/**
 * One keydown listener's worth of logic, with no DOM of its own so it can be
 * unit tested. Sequences resolve through the keymap; an exact match runs, a
 * prefix waits (and runs its own command on timeout when it has one), and a
 * miss restarts the sequence with the current key so `g x j` still moves.
 */
export const createKeyEngine = ({
  keymap,
  run,
  isEnabled = () => true,
  passthrough = [],
  isSuspended = () => false,
  timeoutMs = 800,
  onPendingChange = () => undefined,
  setTimeout: schedule = (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: cancel = (id) => window.clearTimeout(id),
}: KeyEngineOptions): KeyEngine => {
  let pending: Chord[] = [];
  let timer: number | null = null;

  const setPending = (next: Chord[]) => {
    pending = next;
    onPendingChange(pending);
  };

  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const reset = () => {
    clearTimer();
    if (pending.length) {
      setPending([]);
    }
  };

  const fire = (command: string, event: KeyboardEvent) => {
    reset();
    if (run(command, event)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  };

  const attempt = (sequence: Chord[], event: KeyboardEvent): boolean => {
    const resolution = keymap.resolve(sequence);
    if (resolution.kind === "exact") {
      if (!isEnabled(resolution.command)) {
        reset();
        return false;
      }
      return fire(resolution.command, event);
    }
    if (resolution.kind === "prefix") {
      clearTimer();
      setPending(sequence);
      const own =
        resolution.command && isEnabled(resolution.command)
          ? resolution.command
          : null;
      timer = schedule(() => {
        timer = null;
        if (own) {
          reset();
          run(own, event);
        } else {
          reset();
        }
      }, timeoutMs);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  };

  return {
    pending: () => pending,
    reset,
    handle: (event) => {
      if (isSuspended() || event.defaultPrevented) {
        return false;
      }
      const chord = chordFromEvent(event);
      if (!chord) {
        return false;
      }
      if (isTypingTarget(event.target)) {
        reset();
        if (!passthrough.includes(chord)) {
          return false;
        }
      }
      const sequence = [...pending, chord];
      if (attempt(sequence, event)) {
        return true;
      }
      const hadPrefix = pending.length > 0;
      reset();
      return hadPrefix ? attempt([chord], event) : false;
    },
  };
};
