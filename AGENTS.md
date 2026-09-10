# AGENTS.md

`draw` is a fork of github.com/excalidraw/excalidraw that turns excalidraw.com's
own editor into a self-hosted Excalidraw+. Read `SPEC.md` before changing
anything; it is the product and API contract.

## Layout

```
excalidraw-app/     excalidraw.com's app, forked. Our changes live here.
  collab/socket.ts  websocket transport shim replacing socket.io-client
  data/server.ts    room/file persistence against /api (replaces firebase.ts)
  data/api.ts       typed client for the rest of /api
  dashboard/        dashboard, sign-in, share dialog, router, activity rail
  dashboard/keyboard/  the dashboard's key engine and command registry (see below)
packages/           upstream editor packages. Never edit.
server/             Go backend, single binary, embeds excalidraw-app/build
  cmd/draw/         main
  internal/         api, auth, ws, store, crypto, static, importer
  web/dist/         build output copied here by the Nix build (gitignored)
nix/                flake helpers; flake.nix at the root
scripts/            repo tooling (upstream helpers, crypto test vectors)
```

## Upstream tracking

- Remote `upstream` is github.com/excalidraw/excalidraw; `origin` is
  git.harivan.sh/harivansh-afk/draw. Sync with `git merge upstream/master`.
- `packages/`, `examples/`, `scripts/` (upstream ones) and the root tooling are
  upstream's. Do not modify them; if the editor needs a change, it goes to
  upstream first.
- Keep `excalidraw-app/` diffs against upstream minimal and mechanical so
  merges stay cheap: swap imports, add files, delete promo code. Do not
  reformat or reorganise upstream files. New behaviour goes into new files.
- The editor's behaviour is sacred: no keybinding, gesture, menu, tool or
  rendering changes. If you find yourself touching `packages/excalidraw`, stop.

## Commands

```
yarn install --frozen-lockfile        # node 24 + yarn 1.22 via corepack
yarn --cwd excalidraw-app start       # vite dev server on :3001, proxies /api to :34729
yarn build:app                        # excalidraw-app/build
yarn test:app                         # vitest for excalidraw-app
cd server && go build ./... && go test ./...
DRAW_DEV_LOGIN=1 go run ./cmd/draw serve   # local server with dev login
nix build .#default                   # full binary with embedded frontend
```

## Conventions

- Go: standard library first, `internal/` packages, table-driven tests, no
  ORM, errors wrapped with context. Handlers return typed JSON errors
  (`{"error","message"}`).
- TypeScript: match upstream style (prettier config is upstream's). No new
  runtime dependencies without a reason written in the PR.
- One keyboard engine owns the dashboard's document listener
  (`dashboard/keyboard/useKeyEngine.ts`); nothing else binds keys globally.
  Menus, dialogs and inputs keep their own element-scoped handlers and the
  engine yields while they are open. The editor pages keep upstream's.
- No comments that restate code. Explain non-obvious decisions in one line.
- Commits: imperative subject, body says why. PRs go to Forgejo (`origin`).
- Secrets never enter the repo or the Nix store.

## Dashboard keyboard model

`excalidraw-app/dashboard/keyboard/` is pure TypeScript with one React hook,
and imports only public `@excalidraw/common` helpers (`KEYS`' platform rule,
`isWritableElement`), never editor internals:

- `chord.ts` turns a KeyboardEvent into text (`G`, `mod+k`, `shift+enter`).
- `keymap.ts` is a trie over key sequences: exact, prefix, or miss.
- `engine.ts` holds one listener's state: pending sequence, vim-style prefix
  timeout, restart on a miss, typing-target bypass with a passthrough list.
- `commands.ts` is the single registry. A command's `keys`, `label`, `when`
  and `run` drive the bindings, the palette rows and the `?` sheet at once,
  so add or change a shortcut there and nowhere else. Never bind a key by
  hand in a component.
- `grid.ts`, `fuzzy.ts`, `format.ts` are the cursor math, palette ranking
  and chip rendering. All of it is covered by `dashboard/tests/keyboard.test.ts`.

The dashboard's visual language is harivan.sh's (mono, three colours, dotted
underlines); see SPEC.md "Dashboard". The editor's own UI stays upstream's.

## Upstream guidelines (kept from upstream AGENTS.md)

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.
- When overriding properties of an existing type, prefer `Merge<Base, Overrides>` from `@excalidraw/common/utility-types` over `Omit<Base, keyof Overrides> & Overrides`.
