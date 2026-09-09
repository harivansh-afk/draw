# draw

> [!IMPORTANT]
> This is a read-only mirror of <https://git.harivan.sh/harivansh-afk/draw>. Use Forgejo for issues, pull requests, and active development.

Self-hosted Excalidraw+. The editor is excalidraw.com's own code, unmodified in
behaviour. Around it: accounts, a dashboard, persistent scenes with autosave,
always-on live collaboration on every scene, share links with view or edit
access, snapshot links, a synced library, thumbnails, collections and trash.
One Go binary, one SQLite database, one data directory.

This repository is a fork of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw).
Everything under `packages/` is upstream, untouched. The application shell in
`excalidraw-app/` is upstream's excalidraw.com app with its Firebase and
socket.io plumbing swapped for the server in `server/`.

## What you get

| Route | What it is |
| --- | --- |
| `/` | Dashboard: scenes grid with thumbnails, collections, trash, search, import of `.excalidraw` files. Sign-in screen when signed out. |
| `/s/<id>` | A saved scene in the editor. Autosaves two seconds after each change. Always live: open it twice and you get cursors, selections and follow mode. |
| `/local` | excalidraw.com verbatim: local storage, `#json=` snapshot import, ad-hoc `#room=` sessions. No account needed. |

Sharing is per scene: **Private**, **anyone with the link can view**, or
**anyone with the link can edit**. The server enforces it on HTTP and on the
WebSocket relay; turning a link off disconnects guests within seconds.

## What was added

| Path | Purpose |
| --- | --- |
| `server/` | Go backend: Google sign-in (OIDC), sessions, scenes, collections, rooms with optimistic concurrency and version history, encrypted file storage, snapshot links, library sync, thumbnails, the WebSocket relay, rate limits, SQLite migrations, background purges, `import-excalidash`, `backup`. |
| `excalidraw-app/dashboard/` | The dashboard and sign-in screen, styled with Excalidraw's own tokens. |
| `excalidraw-app/scene/` | Scene mode: route parsing, loading `/s/<id>`, the top-left name and save indicator, the private-scene page, thumbnail rendering. |
| `excalidraw-app/scene-sidebar/` | The in-editor scenes panel, like Excalidraw+. |
| `excalidraw-app/share/SceneShareDialog.tsx` | Share dialog for scenes: public link toggle, view/edit, snapshot export. |
| `excalidraw-app/collab/socket.ts` | WebSocket transport with the subset of the socket.io-client API upstream's collab code uses, so `Collab.tsx` and `Portal.tsx` stay upstream. |
| `excalidraw-app/data/server.ts` | Room and file persistence against `/api`, replacing `data/firebase.ts` function for function. |
| `excalidraw-app/data/api.ts`, `auth.ts`, `library.ts` | Typed API client, signed-in user state, server-backed library adapter. |
| `flake.nix`, `nix/module.nix` | Nix package (yarn offline build + Go, frontend embedded) and a NixOS module (`services.draw`). |
| `SPEC.md` | The product and API contract everything above is built against. |
| `scripts/gen-crypto-vectors.mjs`, `scripts/mock-api.mjs` | Test vectors for the encryption formats; an in-memory API for dashboard development. |

## What was changed in upstream's app

The intent is that `excalidraw-app/` stays mergeable with upstream. Changes are
mechanical: swap an import, remove a block, add a branch.

| File | Change |
| --- | --- |
| `App.tsx` | Scene-mode branch in `initializeScene`; `viewModeEnabled` for read-only guests; scene name as the editor `name`; scenes sidebar wrapper; Excalidraw+ promo, iframe export and sidebar upsells removed; "Save to dashboard" replaces the Excalidraw+ cloud export; server library adapter when signed in. |
| `collab/Collab.tsx`, `collab/Portal.tsx` | Import the transport shim instead of socket.io-client; call `data/server.ts` instead of Firebase; 2 s save throttle in scene mode; read-only clients never save or broadcast; signed-in name as the default collaborator name. |
| `data/index.ts` | Snapshot links post to `/api/v2/post` and open at `/local#json=…`; files go to `/api/files/shareLinks/…`. |
| `components/AppMainMenu.tsx`, `AppWelcomeScreen.tsx`, `AppFooter.tsx`, `AI.tsx`, `TopErrorBoundary.tsx` | Excalidraw+ items replaced by Dashboard / Save to dashboard / Sign out; welcome centre card hidden in scene mode; Sentry removed. |
| `index.tsx`, `index.html` | Routing between dashboard and editor; analytics and Sentry snippets removed; excalidraw.com meta URLs removed. |
| `app_constants.ts`, `.env.*`, `vite.config.mts`, `vite-env.d.ts` | Storage prefixes and intervals; Firebase and Plus variables removed; dev proxy for `/api`; the service worker never caches `/api`. |
| `package.json`, `yarn.lock` | `firebase`, `socket.io-client`, `@sentry/browser`, `callsites`, `vite-plugin-sitemap` removed. Nothing added. |

Deleted: `data/firebase.ts`, `sentry.ts`, `ExcalidrawPlusIframeExport.tsx`,
`ExcalidrawPlusPromoBanner.tsx`, `AppSidebar.tsx` (the comments/presentation
upsell tabs), `.github/workflows/` (replaced by `.forgejo/workflows/`).

No keybinding, tool, menu, dialog, gesture or rendering behaviour changed.
`packages/` has a zero-line diff against upstream.

## Compatibility with Excalidraw

- Files: `.excalidraw` files, the library format, clipboard payloads and PNG/SVG
  exports with embedded scene data are upstream's, byte for byte. Anything you
  export here opens on excalidraw.com and vice versa.
- Snapshot links: same `#json=<id>,<key>` scheme and the same encrypted blob
  format, served by this server instead of json.excalidraw.com.
- Encryption: rooms and files are encrypted client-side with upstream's
  AES-GCM key format. The server stores the per-scene key so it can hand it to
  people you share with, duplicate scenes and import; the wire and disk formats
  are the upstream ones.
- Collaboration: the sync algorithm, reconciliation and cursor protocol are
  upstream's. The transport is this server's WebSocket relay instead of
  excalidraw-room, so a `#room=` link from excalidraw.com cannot be joined
  here and the reverse; both sides need the same server, which is true of
  excalidraw.com itself.

## Staying current with upstream

`upstream` is github.com/excalidraw/excalidraw. Syncing is a merge:

```
git fetch upstream
git merge upstream/master
```

A weekly Forgejo workflow (`.forgejo/workflows/upstream-sync.yml`) does exactly
that on a branch and opens a pull request; CI builds and tests it. When the
merge conflicts, the workflow opens an issue instead and the merge is done by
hand. Because the diff against upstream is confined to `excalidraw-app/` and
mechanical, conflicts are rare and small.

Deployments track the `main` branch through the Nix flake; a host that consumes
the flake picks up merged syncs on its next `nix flake update`.

## Running it

```
yarn install --frozen-lockfile              # node 24, yarn 1.22 (corepack)
cd server && DRAW_DEV_LOGIN=1 DRAW_BASE_URL=http://localhost:3001 \
  DRAW_DATA_DIR=/tmp/draw go run ./cmd/draw serve
yarn --cwd excalidraw-app start             # vite on :3001, proxies /api
```

`DRAW_DEV_LOGIN=1` enables a password-less sign-in form for development. Never
set it in production. `DRAW_BASE_URL` must be the origin the browser uses,
because the server checks `Origin` on writes and WebSocket upgrades.

Production build and configuration are documented in
[`server/README.md`](server/README.md). With Nix:

```
nix build .#default                         # single binary, frontend embedded
```

and on NixOS:

```nix
imports = [ draw.nixosModules.default ];
services.draw = {
  enable = true;
  baseUrl = "https://draw.example.com";
  environmentFile = "/run/secrets/draw-google-oauth.env";  # OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
  backup.enable = true;
};
```

Put a reverse proxy in front of `127.0.0.1:34729` that forwards
`X-Forwarded-Proto` and the client IP; WebSockets pass through unchanged.

## Tests

```
yarn test:typecheck && yarn test:app        # frontend
cd server && go vet ./... && go test -race ./...
```

## License

MIT, as upstream. Excalidraw is a trademark of the Excalidraw team; this is an
independent self-hosted deployment of their open-source editor.
