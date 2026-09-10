import type { Chord } from "./chord";

/** One key sequence bound to a command id. `["g", "t"]` is a vim-style chord. */
export type Binding = { keys: Chord[]; command: string };

export type Resolution =
  | { kind: "exact"; command: string }
  | { kind: "prefix"; command: string | null }
  | { kind: "none" };

type Node = { command: string | null; next: Map<Chord, Node> };

const node = (): Node => ({ command: null, next: new Map() });

/**
 * A trie over key sequences. `resolve` reports whether the typed sequence is
 * a complete binding, the start of a longer one (optionally also complete,
 * which the engine settles by timeout, as vim does), or nothing.
 */
export type Keymap = {
  resolve: (sequence: Chord[]) => Resolution;
  bindings: readonly Binding[];
};

export const createKeymap = (bindings: readonly Binding[]): Keymap => {
  const root = node();
  for (const binding of bindings) {
    let current = root;
    for (const chord of binding.keys) {
      let next = current.next.get(chord);
      if (!next) {
        next = node();
        current.next.set(chord, next);
      }
      current = next;
    }
    if (current.command && current.command !== binding.command) {
      throw new Error(
        `keys "${binding.keys.join(" ")}" bound to both ${
          current.command
        } and ${binding.command}`,
      );
    }
    current.command = binding.command;
  }
  return {
    bindings,
    resolve: (sequence) => {
      let current = root;
      for (const chord of sequence) {
        const next = current.next.get(chord);
        if (!next) {
          return { kind: "none" };
        }
        current = next;
      }
      if (current.next.size > 0) {
        return { kind: "prefix", command: current.command };
      }
      return current.command
        ? { kind: "exact", command: current.command }
        : { kind: "none" };
    },
  };
};
