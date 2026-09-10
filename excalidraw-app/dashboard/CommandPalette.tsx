import clsx from "clsx";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { editorPath } from "./router";
import { Kbd } from "./ui";
import {
  CATEGORY_ORDER,
  COMMANDS,
  isEnabled,
  labelOf,
} from "./keyboard/commands";
import { formatKeys } from "./keyboard/format";
import { fuzzyRank } from "./keyboard/fuzzy";

import type { Category, CommandContext } from "./keyboard/commands";

type Item = {
  id: string;
  label: string;
  category: Category | "open";
  keywords: string;
  keys: string | null;
  run: () => void;
};

const RECENT_SCENES = 6;

/**
 * Items are rebuilt from the registry plus the current scenes and
 * collections each time the palette opens, so "open <scene>" and
 * "go to <collection>" rows are always current. Ranking is the same fuzzy
 * scorer for every row; with no query the list is grouped by category.
 */
const buildItems = (ctx: CommandContext): Item[] => {
  const items: Item[] = [];
  for (const command of COMMANDS) {
    if (command.hidden || !isEnabled(command, ctx)) {
      continue;
    }
    const label = labelOf(command, ctx);
    items.push({
      id: command.id,
      label,
      category: command.category,
      keywords: `${label} ${command.keywords?.join(" ") ?? ""}`,
      keys: command.keys[0] ? formatKeys(command.keys[0]) : null,
      run: () => command.run(ctx),
    });
  }
  ctx.collections.forEach((collection, index) => {
    if (collection.id === ctx.collectionId) {
      return;
    }
    items.push({
      id: `collection:${collection.id}`,
      label: `Go to ${collection.name}`,
      category: "navigate",
      keywords: `${collection.name} collection`,
      keys: index < 9 ? formatKeys(["g", String(index + 1)]) : null,
      run: () => ctx.navigate({ view: "scenes", collectionId: collection.id }),
    });
  });
  if (ctx.view === "scenes") {
    for (const scene of ctx.scenes) {
      items.push({
        id: `scene:${scene.id}`,
        label: scene.name,
        category: "open",
        keywords: `open ${scene.name}`,
        keys: null,
        run: () => window.location.assign(editorPath(scene.id)),
      });
    }
  }
  return items;
};

const GROUPS: { key: Item["category"]; label: string }[] = [
  ...CATEGORY_ORDER.map((key) => ({ key, label: key })),
  { key: "open", label: "open" },
];

export const CommandPalette = ({
  ctx,
  onClose,
}: {
  ctx: CommandContext;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => buildItems(ctx), [ctx]);

  const visible = useMemo(() => {
    if (query.trim()) {
      return fuzzyRank(all, query, (item) => item.keywords);
    }
    const scenes = all.filter((item) => item.category === "open");
    return [
      ...all.filter((item) => item.category !== "open"),
      ...scenes.slice(0, RECENT_SCENES),
    ];
  }, [all, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = (item: Item) => {
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = (delta: number) => {
      event.preventDefault();
      if (visible.length) {
        setSelected((visible.length + selected + delta) % visible.length);
      }
    };
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "j")) {
      step(1);
    } else if (
      event.key === "ArrowUp" ||
      (event.ctrlKey && event.key === "k")
    ) {
      step(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = visible[selected];
      if (item) {
        run(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup: Item["category"] | null = null;

  return createPortal(
    <div
      className="dash-portal dash-palette__backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="dash-palette"
        role="dialog"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="dash-palette__input"
          placeholder="Type a command or a scene…"
          aria-label="Command"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="dash-palette__list" ref={listRef} role="listbox">
          {visible.length === 0 && (
            <div className="dash-palette__empty">Nothing matches.</div>
          )}
          {visible.map((item, index) => {
            const grouped = !query.trim();
            const heading =
              grouped && item.category !== lastGroup
                ? GROUPS.find((g) => g.key === item.category)?.label
                : null;
            lastGroup = item.category;
            return (
              <React.Fragment key={item.id}>
                {heading && (
                  <div className="dash-palette__group">{heading}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  data-index={index}
                  className={clsx("dash-palette__item", {
                    "dash-palette__item--selected": index === selected,
                  })}
                  onPointerMove={() => setSelected(index)}
                  onClick={() => run(item)}
                >
                  {item.category === "open" && (
                    <span className="dash-palette__verb">Open </span>
                  )}
                  <span className="dash-palette__label">{item.label}</span>
                  {!grouped && (
                    <span className="dash-palette__category">
                      {item.category}
                    </span>
                  )}
                  {item.keys && <Kbd keys={item.keys} />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="dash-palette__foot">
          <span>
            <Kbd keys="↑ ↓" /> Move
          </span>
          <span>
            <Kbd keys="↵" /> Run
          </span>
          <span>
            <Kbd keys="esc" /> Close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
};
