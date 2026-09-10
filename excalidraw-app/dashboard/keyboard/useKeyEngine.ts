import { useEffect, useRef, useState } from "react";

import { commandById, isEnabled, KEYMAP, PASSTHROUGH } from "./commands";
import { createKeyEngine } from "./engine";

import type { Chord } from "./chord";
import type { CommandContext } from "./commands";

/**
 * Mounts the one document-level keydown listener the dashboard has. Runs in
 * the capture phase, like the editor's own palette shortcut, so it sees keys
 * before any element handler; it yields entirely while a menu, dialog or the
 * palette is open, since those own their keys. The context is read through a
 * ref so commands always see the latest render without re-binding.
 */
export const useKeyEngine = (
  ctx: CommandContext,
  { enabled = true }: { enabled?: boolean } = {},
) => {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [pending, setPending] = useState<Chord[]>([]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const engine = createKeyEngine({
      keymap: KEYMAP,
      passthrough: PASSTHROUGH,
      isSuspended: () =>
        document.querySelector(
          ".dash-menu, .dash-modal__backdrop, .dash-palette, .dash-help",
        ) !== null,
      isEnabled: (id) => {
        const command = commandById.get(id);
        return command ? isEnabled(command, ctxRef.current) : false;
      },
      run: (id) => {
        const command = commandById.get(id);
        if (!command) {
          return false;
        }
        return command.run(ctxRef.current) !== false;
      },
      onPendingChange: setPending,
    });
    const onKeyDown = (event: KeyboardEvent) => {
      engine.handle(event);
    };
    const onBlur = () => engine.reset();
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      engine.reset();
    };
  }, [enabled]);

  return { pending };
};
