import { editorPath } from "../router";

import { isTypingTarget } from "./chord";
import { moveIndex } from "./grid";
import { createKeymap } from "./keymap";

import type { Collection, SceneMeta } from "../../data/api";
import type { DashboardRoute } from "../router";
import type { SortKey } from "../state";
import type { Chord } from "./chord";
import type { Binding } from "./keymap";

export type Category = "scene" | "navigate" | "view" | "create" | "account";

export const CATEGORY_ORDER: Category[] = [
  "scene",
  "create",
  "navigate",
  "view",
  "account",
];

/**
 * Everything a command may read or do. The dashboard fills this in from its
 * state on every render; commands never reach into React or the DOM beyond
 * what is handed to them here.
 */
export type CommandContext = {
  view: "scenes" | "trash";
  collectionId: string | null;
  collections: Collection[];
  scenes: SceneMeta[];
  cursor: SceneMeta | null;
  cursorIndex: number | null;
  searchActive: boolean;
  query: string;
  sidebarOpen: boolean;
  columns: () => number;
  setCursorIndex: (index: number | null) => void;
  setCursorId: (id: string | null) => void;
  navigate: (route: DashboardRoute) => void;
  createScene: () => void;
  openImport: () => void;
  focusSearch: () => void;
  clearSearch: () => void;
  blurSearch: () => void;
  closeSidebar: () => void;
  setSort: (sort: SortKey) => void;
  toggleTheme: () => void;
  openPalette: () => void;
  openHelp: () => void;
  emptyTrash: () => void;
  newCollection: () => void;
  signOut: () => void;
  scene: {
    rename: (scene: SceneMeta) => void;
    share: (scene: SceneMeta) => void;
    move: (scene: SceneMeta) => void;
    duplicate: (scene: SceneMeta) => void;
    remove: (scene: SceneMeta) => void;
    restore: (scene: SceneMeta) => void;
  };
};

export type Command = {
  id: string;
  label: string | ((ctx: CommandContext) => string);
  category: Category;
  /** Alternative key sequences; each inner array is one sequence. */
  keys: Chord[][];
  keywords?: string[];
  when?: (ctx: CommandContext) => boolean;
  /** Listed in help but not in the palette (motions, escape). */
  hidden?: boolean;
  /** Return false to let the browser handle the key after all. */
  run: (ctx: CommandContext) => boolean | void;
};

const hasCursor = (ctx: CommandContext) => ctx.cursor !== null;
const inScenes = (ctx: CommandContext) => ctx.view === "scenes";
const inTrash = (ctx: CommandContext) => ctx.view === "trash";

const move = (direction: "up" | "down" | "left" | "right", keys: Chord[][]) =>
  ({
    id: `cursor.${direction}`,
    label: `cursor ${direction}`,
    category: "scene",
    keys,
    hidden: true,
    when: (ctx) => ctx.scenes.length > 0,
    run: (ctx) => {
      ctx.setCursorIndex(
        moveIndex(ctx.cursorIndex, ctx.scenes.length, ctx.columns(), direction),
      );
    },
  } as Command);

/** The next collection after the current view, wrapping through the dashboard. */
const cycleCollection = (ctx: CommandContext, step: 1 | -1) => {
  const ids: (string | null)[] = [null, ...ctx.collections.map((c) => c.id)];
  const current = ctx.view === "trash" ? -1 : ids.indexOf(ctx.collectionId);
  const next = ids[(current + step + ids.length) % ids.length];
  ctx.navigate({ view: "scenes", collectionId: next ?? null });
};

export const COMMANDS: Command[] = [
  move("down", [["j"], ["down"]]),
  move("up", [["k"], ["up"]]),
  move("left", [["h"], ["left"]]),
  move("right", [["l"], ["right"]]),
  {
    id: "cursor.first",
    label: "first scene",
    category: "scene",
    keys: [["g", "g"]],
    hidden: true,
    when: (ctx) => ctx.scenes.length > 0,
    run: (ctx) => ctx.setCursorIndex(0),
  },
  {
    id: "cursor.last",
    label: "last scene",
    category: "scene",
    keys: [["G"]],
    hidden: true,
    when: (ctx) => ctx.scenes.length > 0,
    run: (ctx) => ctx.setCursorIndex(ctx.scenes.length - 1),
  },
  {
    id: "scene.open",
    label: "open",
    category: "scene",
    keys: [["enter"], ["o"]],
    when: (ctx) => hasCursor(ctx) && inScenes(ctx),
    run: (ctx) => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("a, button")) {
        return false;
      }
      window.location.assign(editorPath(ctx.cursor!.id));
    },
  },
  {
    id: "scene.openTab",
    label: "open in new tab",
    category: "scene",
    keys: [["shift+enter"]],
    when: (ctx) => hasCursor(ctx) && inScenes(ctx),
    run: (ctx) => {
      window.open(editorPath(ctx.cursor!.id), "_blank", "noopener");
    },
  },
  {
    id: "scene.rename",
    label: "rename",
    category: "scene",
    keys: [["r"]],
    when: (ctx) => hasCursor(ctx) && inScenes(ctx),
    run: (ctx) => ctx.scene.rename(ctx.cursor!),
  },
  {
    id: "scene.share",
    label: "share",
    category: "scene",
    keys: [["s"]],
    when: (ctx) => hasCursor(ctx) && inScenes(ctx),
    run: (ctx) => ctx.scene.share(ctx.cursor!),
  },
  {
    id: "scene.move",
    label: "move to collection",
    category: "scene",
    keys: [["m"]],
    when: (ctx) => hasCursor(ctx) && inScenes(ctx),
    run: (ctx) => ctx.scene.move(ctx.cursor!),
  },
  {
    id: "scene.duplicate",
    label: "duplicate",
    category: "scene",
    keys: [["y"]],
    keywords: ["copy", "yank"],
    when: (ctx) => hasCursor(ctx) && inScenes(ctx),
    run: (ctx) => ctx.scene.duplicate(ctx.cursor!),
  },
  {
    id: "scene.remove",
    label: (ctx) => (inTrash(ctx) ? "delete permanently" : "move to trash"),
    category: "scene",
    keys: [["d", "d"]],
    keywords: ["delete", "remove"],
    when: hasCursor,
    run: (ctx) => ctx.scene.remove(ctx.cursor!),
  },
  {
    id: "scene.restore",
    label: "restore",
    category: "scene",
    keys: [["u"]],
    keywords: ["undo", "undelete"],
    when: (ctx) => hasCursor(ctx) && inTrash(ctx),
    run: (ctx) => ctx.scene.restore(ctx.cursor!),
  },
  {
    id: "scene.new",
    label: "new scene",
    category: "create",
    keys: [["n"]],
    keywords: ["create", "draw"],
    when: inScenes,
    run: (ctx) => ctx.createScene(),
  },
  {
    id: "scene.import",
    label: "import scenes",
    category: "create",
    keys: [["i"]],
    keywords: ["upload", "excalidraw", "file"],
    when: inScenes,
    run: (ctx) => ctx.openImport(),
  },
  {
    id: "collection.new",
    label: "new collection",
    category: "create",
    keys: [["c"]],
    run: (ctx) => ctx.newCollection(),
  },
  {
    id: "go.dashboard",
    label: "go to dashboard",
    category: "navigate",
    keys: [["g", "d"]],
    keywords: ["home", "scenes"],
    run: (ctx) => ctx.navigate({ view: "scenes", collectionId: null }),
  },
  {
    id: "go.trash",
    label: "go to trash",
    category: "navigate",
    keys: [["g", "t"]],
    run: (ctx) => ctx.navigate({ view: "trash" }),
  },
  ...Array.from({ length: 9 }, (_, i): Command => {
    const n = i + 1;
    return {
      id: `go.collection.${n}`,
      label: (ctx) => `go to ${ctx.collections[i]?.name ?? `collection ${n}`}`,
      category: "navigate",
      keys: [["g", String(n)]],
      hidden: true,
      when: (ctx) => ctx.collections.length > i,
      run: (ctx) =>
        ctx.navigate({ view: "scenes", collectionId: ctx.collections[i].id }),
    };
  }),
  {
    id: "collection.next",
    label: "next collection",
    category: "navigate",
    keys: [["]"]],
    when: (ctx) => ctx.collections.length > 0,
    run: (ctx) => cycleCollection(ctx, 1),
  },
  {
    id: "collection.prev",
    label: "previous collection",
    category: "navigate",
    keys: [["["]],
    when: (ctx) => ctx.collections.length > 0,
    run: (ctx) => cycleCollection(ctx, -1),
  },
  {
    id: "search.focus",
    label: "search",
    category: "view",
    keys: [["/"]],
    keywords: ["find", "filter"],
    run: (ctx) => ctx.focusSearch(),
  },
  {
    id: "sort.updated",
    label: "sort by last edited",
    category: "view",
    keys: [],
    run: (ctx) => ctx.setSort("updated"),
  },
  {
    id: "sort.name",
    label: "sort by name",
    category: "view",
    keys: [],
    run: (ctx) => ctx.setSort("name"),
  },
  {
    id: "sort.created",
    label: "sort by created",
    category: "view",
    keys: [],
    run: (ctx) => ctx.setSort("created"),
  },
  {
    id: "theme.toggle",
    label: "toggle theme",
    category: "view",
    keys: [[","]],
    keywords: ["dark", "light", "mode"],
    run: (ctx) => ctx.toggleTheme(),
  },
  {
    id: "palette.open",
    label: "command palette",
    category: "view",
    keys: [["mod+k"], ["mod+/"], ["mod+shift+p"]],
    hidden: true,
    run: (ctx) => ctx.openPalette(),
  },
  {
    id: "help.open",
    label: "keyboard shortcuts",
    category: "view",
    keys: [["?"]],
    keywords: ["help", "keys", "bindings"],
    run: (ctx) => ctx.openHelp(),
  },
  {
    id: "trash.empty",
    label: "empty trash",
    category: "view",
    keys: [],
    when: (ctx) => inTrash(ctx) && ctx.scenes.length > 0,
    run: (ctx) => ctx.emptyTrash(),
  },
  {
    id: "escape",
    label: "clear",
    category: "view",
    keys: [["escape"]],
    hidden: true,
    run: (ctx) => {
      const active = document.activeElement;
      if (ctx.searchActive) {
        if (ctx.query) {
          ctx.clearSearch();
        } else {
          ctx.blurSearch();
        }
        return true;
      }
      if (isTypingTarget(active)) {
        return false;
      }
      if (ctx.query) {
        ctx.clearSearch();
      } else if (ctx.cursor) {
        ctx.setCursorId(null);
      } else if (ctx.sidebarOpen) {
        ctx.closeSidebar();
      } else {
        return false;
      }
    },
  },
  {
    id: "account.signOut",
    label: "sign out",
    category: "account",
    keys: [],
    run: (ctx) => ctx.signOut(),
  },
];

/** Chords that fire even while a text field has focus. */
export const PASSTHROUGH: Chord[] = [
  "escape",
  ...COMMANDS.find((c) => c.id === "palette.open")!.keys.map((k) => k[0]),
];

export const bindingsOf = (commands: readonly Command[]): Binding[] =>
  commands.flatMap((command) =>
    command.keys.map((keys) => ({ keys, command: command.id })),
  );

export const KEYMAP = createKeymap(bindingsOf(COMMANDS));

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

export const labelOf = (command: Command, ctx: CommandContext) =>
  typeof command.label === "function" ? command.label(ctx) : command.label;

export const isEnabled = (command: Command, ctx: CommandContext) =>
  command.when ? command.when(ctx) : true;
