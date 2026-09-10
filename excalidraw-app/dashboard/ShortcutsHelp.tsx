import React, { useEffect } from "react";
import { createPortal } from "react-dom";

import { Kbd } from "./ui";
import {
  CATEGORY_ORDER,
  COMMANDS,
  isEnabled,
  labelOf,
} from "./keyboard/commands";
import { formatKeys } from "./keyboard/format";

import type { CommandContext } from "./keyboard/commands";

/**
 * The key sheet, rendered from the same registry that drives the bindings,
 * so it cannot drift. Motions are listed here even though the palette hides
 * them. Closes on `?` or escape.
 */
export const ShortcutsHelp = ({
  ctx,
  onClose,
}: {
  ctx: CommandContext;
  onClose: () => void;
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    rows: COMMANDS.filter(
      (command) =>
        command.category === category &&
        command.keys.length > 0 &&
        (command.when === undefined ||
          isEnabled(command, ctx) ||
          command.category === "scene"),
    ),
  })).filter((group) => group.rows.length > 0);

  return createPortal(
    <div
      className="dash-portal dash-help__backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="dash-help" role="dialog" aria-label="Keyboard shortcuts">
        <div className="dash-help__head">
          <span className="dash-label">keys</span>
          <span className="dash-help__close">
            <Kbd keys="esc" /> close
          </span>
        </div>
        <div className="dash-help__columns">
          {groups.map((group) => (
            <section key={group.category} className="dash-help__group">
              <h3 className="dash-help__title">{group.category}</h3>
              {group.rows.map((command) => (
                <div key={command.id} className="dash-help__row">
                  <span className="dash-help__keys">
                    {command.keys.slice(0, 2).map((keys, index) => (
                      <React.Fragment key={index}>
                        {index > 0 && <span className="dash-help__or">/</span>}
                        <Kbd keys={formatKeys(keys)} />
                      </React.Fragment>
                    ))}
                  </span>
                  <span className="dash-help__label">
                    {labelOf(command, ctx)}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};
