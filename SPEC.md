# draw: self-hosted Excalidraw+

`draw` is a fork of the excalidraw monorepo that ships excalidraw.com's own
editor (`excalidraw-app/`) with a Go backend (`server/`) providing accounts, a
dashboard, persistent scenes with autosave, always-on live collaboration on
every scene, share links, snapshot links, a server-synced library, thumbnails,
collections and trash. One binary, one SQLite database, one data directory.

The editor must behave exactly like excalidraw.com. No keybinding, tool, menu,
dialog, gesture or rendering behaviour is changed. Everything under `packages/`
is untouched upstream code. Changes in `excalidraw-app/` are limited to the
persistence layer, the transport, the removal of Excalidraw+ upsells, and the
additions listed in this document.

## Terms

- **Scene**: a saved drawing owned by a user. Has an id, a name, an optional
  collection, a share mode, a room key, timestamps, a thumbnail.
- **Room**: the collaboration + persistence unit the upstream collab code
  talks to. A scene's room id **is** its scene id. Rooms may also exist without
  a scene (ad-hoc `#room=` sessions started from `/local`, exactly like
  excalidraw.com).
- **Room key**: the 22-character base64url AES-GCM-128 key upstream generates
  (`generateEncryptionKey`). All room payloads and files are encrypted by the
  client with it. For scenes the server stores the key and hands it to callers
  with read permission, so the server can also decrypt for duplication and
  import.
- **Snapshot link**: upstream "Export to link": an encrypted blob POSTed to the
  json backend and opened via `#json=<id>,<key>`.

## Frontend routes

| Route | Behaviour |
|------|-----------|
| `/` | Dashboard when signed in, otherwise the sign-in screen. A `#json=` or `#room=` hash at `/` redirects to `/local` with the same hash. |
| `/login` | Sign-in screen. `?next=` returns the user after auth. |
| `/s/:sceneId` | Editor for a scene. Requires owner, or the scene's share mode to allow the caller. Loads via `GET /api/scenes/:id`, then joins the room. |
| `/local` | excalidraw.com verbatim: localStorage persistence, `#json=` import, ad-hoc `#room=` live collaboration, no account needed. Snapshot links generated anywhere in the app point here. |

Any other path serves the SPA `index.html` (client routing). Paths under `/api/`
never fall back to the SPA.

## Editor behaviour in scene mode (`/s/:id`)

1. `GET /api/scenes/:id`. On 401 redirect to `/login?next=`; on 403/404 show a
   full-page "This scene is private or does not exist" island with a link to
   `/`.
2. Call `collabAPI.startCollaboration({ roomId: id, roomKey })`. The upstream
   collab code then joins the websocket room, loads the persisted room from
   `GET /api/rooms/:id`, reconciles, broadcasts, and saves. Nothing about the
   upstream sync algorithm changes.
3. `LocalData` save stays paused for the whole session (upstream already pauses
   it while collaborating). Theme, language, username and library still use
   their upstream storage.
4. Save throttle: `SAVE_TO_SERVER_INTERVAL_MS = 2000` in scene mode (upstream's
   20 s `SYNC_FULL_SCENE_INTERVAL_MS` stays for `/local` rooms).
5. `permission: "view"`: mount with `viewModeEnabled: true`, keep the user in
   view mode (the toggle stays available in the menu but the server rejects
   writes, and Portal skips `broadcastScene` when read-only so nothing is
   attempted). Viewers' cursors and idle state are still relayed (volatile).
6. The scene name is the editor's `name` (drives export filenames). Top-left,
   next to the hamburger menu, an island shows a "back to dashboard" icon
   button, the scene name (click to rename inline, Enter/blur saves via
   `PATCH`, Escape cancels), and a small save-state indicator ("Saving…" /
   "Saved" / "Offline"). Read-only callers see the name without editing.
7. Share dialog (replaces the upstream picker in scene mode only):
   - Link row: `<origin>/s/<id>` with copy button and QR code.
   - Access selector, owner only: **Private** (`private`), **Anyone with the
     link can view** (`view`), **Anyone with the link can edit** (`edit`).
     Changes call `PATCH /api/scenes/:id { shareMode }` immediately.
   - "Your name" field (upstream collab username).
   - Divider, then upstream "Shareable link" (snapshot export) exactly as
     upstream renders it. Snapshot URLs are `<origin>/local#json=<id>,<key>`.
   - No "start session" / "stop session": scenes are always live.
8. Leaving a scene (dashboard button, navigation, unload) flushes a save
   through the upstream `beforeunload`/`stopCollaboration` paths.
9. Welcome screen: hints only, no centre card (its copy is about local
   storage). `/local` keeps the full upstream welcome screen minus the
   Excalidraw+ sign-up item.
10. Thumbnail: after each successful server save, at most once every 10 s, the
    client renders a 640×400 PNG via `exportToCanvas` (transparent background
    off, light-mode colors regardless of the saving client's theme) and
    `PUT /api/scenes/:id/thumbnail`. Owner and editors do this; viewers do not.
11. Editor images: unchanged upstream `FileManager` flow, backed by
    `/api/files/rooms/<roomId>/<fileId>`.

## Editor behaviour everywhere

- Removed: Sentry, tracking, Excalidraw+ promo banner, Excalidraw+ items in the
  main menu, welcome screen, command palette and the sidebar comments /
  presentation upsell tabs, the "Excalidraw+ export" cloud export and its
  `/excalidraw-plus-export` iframe route.
- Added to the main menu, after the default items and before "Socials": in
  scene mode **Dashboard** (navigates to `/`); in `/local` mode **Save to
  dashboard** (signed in: creates a scene from the current canvas and files,
  navigates to `/s/<id>`; signed out: goes to `/login?next=/local`). At the
  bottom, when signed in: **Sign out**.
- The export dialog's custom cloud action ("Excalidraw+" card) becomes "Save to
  dashboard" with the same behaviour; the OverwriteConfirm dialog's cloud action
  likewise. In scene mode these are hidden (the scene is already saved).
- Library: signed-in users get a `LibraryServerAdapter` (`GET/PUT /api/library`)
  as the `adapter` for `useHandleLibrary`, with the upstream IndexedDB adapter
  as `migrationAdapter` so an existing browser library is uploaded once.
  Signed-out users keep the upstream IndexedDB adapter.
- PWA: keep the service worker. `navigateFallbackDenylist` must exclude `/api/`.
  Runtime caching never touches `/api/`.
- Keyboard: the dashboard and any added component register no global key
  handlers. Inside the editor nothing intercepts keys before Excalidraw.

## Dashboard

Visual language is Excalidraw's own (Assistant font, 8–12 px radii, subtle
shadows, islands with 1 px borders) with the purple replaced by a neutral
greyscale: light page `#f6f6f6`, island `#ffffff`, text `#1b1b1f`, borders
`#e8e8e8`, the ink `#1b1b1f` as the only accent (primary buttons, focus,
the keyboard cursor); dark page `#121212`, island `#1e1e1e`, text `#e3e3e3`,
borders `#303030`, ink `#e3e3e3`. Red is reserved for destructive actions.
No gradients, no underlines, no key hints on buttons or menus (keys live in
the palette and the `?` sheet). Theme follows the editor's `excalidraw-theme`
localStorage value (`light`/`dark`/`system`) and the `.dark` class on `<html>`
that upstream `index.html` already sets. The dashboard's scroll container and
the page have `overscroll-behavior: none`, so nothing bounces past the ends.

Layout (≥ 800 px): left sidebar 264 px, main column, and from 1180 px a right
activity rail 240 px wide; 44 px gutter.

Sidebar, top to bottom:
- Workspace row (avatar, "Personal", menu with the email and Sign out).
- Search field (filters by name, client-side, debounced 150 ms).
- Nav: **Dashboard**, **Trash**; then **Collections** heading with a `+`
  button, one row per collection (inline rename on double-click, context menu:
  Rename, Delete collection (scenes stay in the dashboard, not trash)). The
  active row has the hover fill, never a colour.
- Footer: user avatar + name, theme toggle (light/dark/system, writes
  `excalidraw-theme`).

Main column:
- Header: view title (Dashboard, Trash, or the collection name), sort menu
  (Last edited, Name, Created), **Import** and the primary **New scene**
  (creates a scene named "Untitled" in the current collection and opens
  `/s/<id>`). In the trash the header holds **Empty trash** instead.
- Section title ("Recent" on the dashboard, `Results for “…”` while
  searching, none inside a collection or the trash) with the visible count.
- Card grid, `repeat(auto-fill, minmax(232px, 1fr))`, gap 26 px. Card: 4:3
  thumbnail area (`GET /api/scenes/:id/thumbnail`; without one, a blank
  surface), then name (single line, ellipsis), then the relative time
  (refreshed each minute) and a link glyph when shared. Whole card opens the
  scene. Hover, focus or the keyboard cursor reveals a `…` button; menu:
  Rename, Share, Duplicate, Move, Move to trash. Middle-click / Cmd-click
  opens a new tab (it is a real `<a>`).

Activity rail (right, hidden under 1180 px): `GET /api/activity`, grouped by
day ("Today", "Yesterday", weekday within the week, else "12 Aug"), each entry
one line of muted verb + bold scene link + muted detail, then the time
(relative today, `HH:MM` otherwise) and `by <actor>` when the actor is not the
signed-in user ("someone with the link" for anonymous editors). Scene names
are current while the scene exists. Scenes in the trash link to `/trash`;
deleted scenes are struck through and not linked. The rail refreshes with the
scene list.
- Trash view: same cards, menu is Restore, Delete permanently; a top notice
  "Scenes in the trash are deleted after 30 days".
- Empty states: one line of muted copy.
- Drag and drop of `.excalidraw` files anywhere over the grid imports each as
  a scene into the current collection (parse with upstream `loadFromBlob`,
  create scene, encrypt elements with the returned room key, `PUT` the room,
  upload files, then refresh). A hidden file input behind the **import** button
  in the top bar does the same.
- Share… from the dashboard opens the same access selector + link + copy as
  the editor's share dialog.
- Thumbnails store light-mode pixels. Dashboard and editor-sidebar previews apply
  the upstream dark filter once at display time, with a 120 ms transition
  (disabled for reduced motion). Switching theme does not fetch or regenerate
  images. Legacy theme-baked thumbnails are invalidated once and backfilled
  from persisted rooms.
- Rename is inline in the card.
- Under 800 px the sidebar collapses behind a menu button; the grid goes to one
  column at 480 px.

### Keyboard

One capture-phase `keydown` listener on the document, mounted by the dashboard
root; it yields while a menu, dialog, the palette or the key sheet is open and
ignores keys typed into fields except `esc` and the palette chords. Sequences
resolve through a trie with an 800 ms prefix timeout; a pending prefix shows as
a chip bottom-right. A grid cursor (outlined card, tracked by scene id so it
survives refreshes) is what scene commands act on; removing the card under it
moves it to the neighbour.

| keys | command |
| --- | --- |
| `j` `k` `h` `l`, arrows | move the cursor (no wrapping) |
| `g g`, `G` | first, last scene |
| `enter`, `o` / `shift+enter` | open / open in a new tab |
| `r` `s` `m` `y` | rename, share, move to collection, duplicate |
| `d d` | move to trash; in the trash, delete permanently (confirm dialog) |
| `u` | restore (trash) |
| `n` `i` `c` | new scene, import, new collection |
| `g d`, `g t`, `g 1`…`g 9`, `[` `]` | dashboard, trash, nth collection, previous/next collection |
| `/` | focus search |
| `,` | toggle light/dark |
| `mod+k`, `mod+/`, `mod+shift+p` | command palette (the last two match the editor) |
| `?` | key sheet |
| `esc` | clear search, then blur it, then drop the cursor, then close the sidebar |

The palette lists every enabled command with its chip, `go to <collection>`
for each collection and `open <scene>` for the visible scenes, fuzzy-ranked
over label and keywords; with no query it is grouped by category and shows
the six most recent scenes. Sort choices, empty trash and sign out are
palette-only. `mod` is ⌘ on macOS and ctrl elsewhere; chips spell it out.

Sign-in screen: centred island, the Excalidraw logo, one line of muted copy,
"Sign in with Google" button (calls `/api/auth/oidc/start?next=…`), and an
error line for `?error=not_allowed` ("This account is not allowed here") or
`?error=oidc`. When `DRAW_DEV_LOGIN=1`
the server also reports `devLogin: true` in `GET /api/auth/config` and the page
shows an email field with "Sign in (dev)".

## Server

Go 1.26, module `git.harivan.sh/harivansh-afk/draw/server`, standard library
`net/http` routing (Go 1.22 patterns), SQLite through `modernc.org/sqlite`
(pure Go), websockets through `github.com/coder/websocket`, OIDC through
`github.com/coreos/go-oidc/v3` + `golang.org/x/oauth2`. No ORM, no framework.
Single binary `draw`, frontend embedded via `embed.FS` from `server/web/dist`
(copied there by the build).

### Commands

```
draw serve                          # default
draw import-excalidash --db dev.db --uploads DIR --owner EMAIL [--dry-run]
draw import-dir DIR --owner EMAIL [--create-owner] [--dry-run] [--data-dir DIR]
draw backup OUT.sqlite [--files DIR] # VACUUM INTO; optional files/ and thumbs/ copy
```

### Configuration (environment; flags of the same name without prefix override)

| Variable | Default | Meaning |
|---|---|---|
| `DRAW_LISTEN` | `127.0.0.1:34729` | HTTP listen address |
| `DRAW_DATA_DIR` | `./data` | SQLite db, files, thumbnails, session key |
| `DRAW_BASE_URL` | `http://localhost:34729` | Public origin; used for OIDC redirect and cookies (`Secure` when https) |
| `OIDC_ISSUER_URL` | `https://accounts.google.com` | |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | Required unless `DRAW_DEV_LOGIN=1` |
| `OIDC_REDIRECT_URI` | `BASE_URL + /api/auth/oidc/callback` | Must match the Google console entry |
| `DRAW_ALLOWED_EMAILS` | empty | Comma-separated allowlist. Empty means: the first account that ever signs in is recorded and becomes the only allowed account. |
| `DRAW_OPEN_SIGNUP` | `0` | `1` lets any verified account sign in (overrides the rule above) |
| `DRAW_DEV_LOGIN` | `0` | `1` enables `POST /api/auth/dev` and disables the OIDC requirement. Never set in production. |
| `DRAW_TRUST_PROXY` | `0` | `1` prefers `CF-Connecting-IP`, else the rightmost valid `X-Forwarded-For` IP after stripping loopback/private hops, for logs and rate limits |
| `DRAW_SESSION_KEY_FILE` | `DATA_DIR/session.key` | 32 random bytes, created with mode 0600 if missing |
| `DRAW_MAX_ROOM_BYTES` | `8388608` | Room payload cap (8 MiB) |
| `DRAW_MAX_FILE_BYTES` | `6291456` | Per-file cap (upstream caps the dataURL at 4 MiB before encoding) |
| `DRAW_TRASH_RETENTION_DAYS` | `30` | Purge interval for trashed scenes |
| `DRAW_ROOM_HISTORY` | `20` | Room versions kept per room |

### Authentication

- Cookie `draw_session`: 32-byte random token, HttpOnly, SameSite=Lax, Path=/,
  Secure when `DRAW_BASE_URL` is https, 30-day sliding expiry. The token's
  SHA-256 is stored in `sessions`. Expiry and the cookie refresh only when
  `last_seen_at` is older than one hour.
- OIDC: standard code flow with `state` and `nonce` in a short-lived cookie,
  scopes `openid email profile`, `email_verified` must be true. Users are keyed
  by `issuer + sub`; email, name and avatar URL are refreshed on each login.
  An email held by a different subject is rejected with `not_allowed`.
- Allowlist: see config. Rejected sign-ins redirect to `/login?error=not_allowed`.
- State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) must carry either
  `Sec-Fetch-Site: same-origin`/`none` or an `Origin` equal to `DRAW_BASE_URL`;
  otherwise 403. This is the CSRF defence; there is no token.

### Permissions

For a scene room, `perm(user, scene)`:
- owner → `owner`
- scene `share_mode = edit` → `edit` (anyone, including anonymous)
- scene `share_mode = view` → `view`
- otherwise → `none`
Trashed scenes (`deleted_at` set) are `none` for everyone except the owner.

For an ad-hoc room (no scene with that id):
- read: anyone
- write: any signed-in user, or anyone if the room already exists (so
  anonymous invitees of a `/local` session can keep saving)
- create: signed-in users only
- websocket broadcast: anyone, even before the first room save; the room key
  protects content

`write` means `owner` or `edit`; `read` means `write` or `view`.

### HTTP API

All JSON responses are objects. Errors are `{"error": "<code>", "message": "…"}`
with a matching status. Timestamps are RFC 3339 UTC strings.

```
SceneMeta {
  id, name, collectionId|null, shareMode: "private"|"view"|"edit",
  createdAt, updatedAt, deletedAt|null, hasThumbnail: bool
}
SceneAccess { scene: SceneMeta, permission: "owner"|"edit"|"view", roomKey }
Collection { id, name, createdAt, sceneCount }
User { id, email, name, avatarUrl }
```

Auth
- `GET  /api/auth/config` → `{ devLogin: bool, provider: "Google" }`
- `GET  /api/auth/me` → `{ user }` or 401
- `GET  /api/auth/oidc/start?next=/path` → 302 to the provider (`next` must be a
  same-origin path, else `/`; fragments are stripped before storage)
- `GET  /api/auth/oidc/callback` → sets the cookie, 302 to `next`
- `POST /api/auth/logout` → clears the cookie, 204
- `POST /api/auth/dev {email, name?}` → dev only; creates/logs in; 204

Scenes (signed in)
- `GET  /api/scenes?collection=<id>|none|all&trash=0|1&q=&sort=updated|name|created&order=asc|desc`
  → `{ scenes: [SceneMeta] }`. Default: `all`, `trash=0`, `updated desc`.
- `POST /api/scenes {name?, collectionId?}` → 201 `SceneAccess` (permission
  `owner`). Id: 10 random bytes as 20 lowercase hex chars (matches upstream
  room ids). Room key: 16 random bytes, base64url unpadded (22 chars).
- `GET  /api/scenes/:id` → `SceneAccess`; 404 when no such scene; 403 when
  `perm = none` (401 instead if anonymous). Anonymous callers with `view` or
  `edit` receive the room key too.
- `PATCH /api/scenes/:id {name?, collectionId?, shareMode?}` → `SceneMeta`, owner only
- `DELETE /api/scenes/:id` → moves to trash, 204. `?permanent=1` (owner only,
  scene must be in trash or not) deletes the scene, its room, room history,
  files and thumbnail, and closes live room members with 4403.
- `POST /api/scenes/:id/restore` → `SceneMeta`
- `POST /api/scenes/:id/duplicate {name?}` → 201 `SceneAccess`. Copies the room
  (decrypt with the old key, encrypt with the new one; same for each file's
  inner ciphertext, see "Formats"), the thumbnail, and the collection.
  Name defaults to `<name> (copy)`.
- `PUT  /api/scenes/:id/thumbnail` body `image/png` ≤ 512 KiB, write permission → 204
- `GET  /api/scenes/:id/thumbnail` → png or 404; read permission;
  `Cache-Control: private, max-age=60`; `ETag` from the file mtime.

Collections (signed in, owner scoped)
- `GET /api/collections` → `{ collections: [Collection] }`
- `POST /api/collections {name}` → 201 `Collection`
- `PATCH /api/collections/:id {name}` → `Collection`
- `DELETE /api/collections/:id` → 204; scenes in it get `collectionId = null`

Activity (signed in, owner scoped)
- `GET /api/activity?limit=40` (1–200) → `{ activity: [Activity] }`, newest first.
  ```
  Activity { id, kind, sceneId|null, sceneName, detail, actorId|null, actorName, at,
             sceneState: "live"|"trash"|"gone" }
  ```
  `sceneName` is the scene's current name while it exists, else the last one
  recorded. `kind` is one of `created`, `edited`, `renamed` (detail: previous name),
  `moved` (detail: target collection name, empty when removed from every
  collection), `shared` (detail: new share mode), `duplicated` (detail: source
  name), `trashed`, `restored`, `deleted`. Rows are written after the mutation
  succeeds and outlive the scene; `sceneName` is the name at the time.
  `actorId` is null for anonymous share-link editors. Room saves record
  `edited`, folded into the previous entry for the same scene when that entry
  is `created`, `duplicated` or `edited`, by the same actor, and less than 30
  minutes old (the entry keeps its kind and moves to the new time), so one
  drawing session is one line. Rows older than 90 days are purged.

Library (signed in)
- `GET /api/library` → the stored JSON document verbatim, or 204 when none
- `PUT /api/library` body JSON ≤ 16 MiB → 204

Rooms (permissions above)
- `GET /api/rooms/:roomId` → `{ rev, sceneVersion, iv, ciphertext }` with `iv`
  and `ciphertext` base64 (standard, padded), header `ETag: "<rev>"`. 404 when
  the room has never been saved.
- `PUT /api/rooms/:roomId {sceneVersion, iv, ciphertext}` with `If-Match: "<rev>"`
  (update) or `If-None-Match: *` (create). → `{ rev }` (200 on update, 201 on
  create). 412 on mismatch; the client then GETs, reconciles and retries. Body
  cap `DRAW_MAX_ROOM_BYTES` → 413 with `error: "too_large"`. Each successful PUT
  appends to `room_versions` (pruned to `DRAW_ROOM_HISTORY`) and, for scene
  rooms, bumps `scenes.updated_at`.
- `GET /api/rooms/:roomId/versions` → `{ versions: [{ rev, sceneVersion, createdAt, bytes }] }` (read)
- `GET /api/rooms/:roomId/versions/:rev` → same shape as `GET /api/rooms/:roomId` (read)

Files
- `PUT /api/files/rooms/:roomId/:fileId` raw bytes ≤ `DRAW_MAX_FILE_BYTES`, room write permission → 204 (idempotent; same id overwrites)
- `GET /api/files/rooms/:roomId/:fileId` → bytes, room read permission, `Cache-Control: private, max-age=31536000, immutable`
- `PUT /api/files/shareLinks/:jsonId/:fileId` → 204 if the snapshot `jsonId` exists, else 404; existing files are immutable (a repeated PUT keeps the first bytes)
- `GET /api/files/shareLinks/:jsonId/:fileId` → bytes, `Cache-Control: public, max-age=31536000, immutable`
File ids are validated as `[A-Za-z0-9_-]{1,128}` (including 96-character Excalidraw+ export ids); room and snapshot ids as `[a-f0-9]{20}` (upstream also accepts `[a-zA-Z0-9_-]+` for legacy rooms; accept `[A-Za-z0-9_-]{1,64}` for rooms).

Snapshot links (upstream json backend contract)
- `POST /api/v2/post` raw body ≤ `DRAW_MAX_ROOM_BYTES` → `{ id }` (20 hex). Signed
  in, or anonymous with `read` on any scene is not knowable here, so: anyone,
  rate limited to 30/hour/IP. A 413 includes `error: "too_large"` and
  `error_class: "RequestTooLargeError"` for the upstream export client.
- `GET /api/v2/:id` → raw bytes, `Cache-Control: public, max-age=31536000, immutable`

Health
- `GET /api/health` → `{ ok: true, version }`

Static
- Everything else: embedded `web/dist`. Hashed assets under `/assets/`,
  `/fonts/`, `/locales/` get `Cache-Control: public, max-age=31536000, immutable`.
  `index.html`, `manifest.webmanifest`, `sw.js` / `service-worker.js` get
  `no-cache`. Unknown non-`/api/` paths serve `index.html` with 200.

Rate limits: sign-in starts 20/min/IP, snapshot posts 30/hour/IP, everything
else 600/min/IP. Never 429 authenticated dashboard reads because of a shared
proxy IP: when `DRAW_TRUST_PROXY=1` the limiter keys on the forwarded IP, and
authenticated requests are keyed on the session instead of the IP.

### WebSocket `/api/ws`

Same-origin upgrade (check `Origin` against `DRAW_BASE_URL`; reject otherwise).
The session cookie, if present, identifies the user.

Every message is one binary WebSocket frame:

```
byte 0        version, always 0x01
bytes 1..4    uint32 big-endian, length N of the JSON header
bytes 5..5+N  JSON header
rest          binary attachments, concatenated, in order
```

Header: `{"e": "<event>", "a": [ ...args ], "b": [ len0, len1, … ]}`. Binary
arguments appear in `a` as `{"$b": i}` referring to attachment `i`; `b` lists
attachment byte lengths in order. `b` is omitted when there are none.

Client → server
- `join-room [roomId]`
- `server-broadcast [roomId, ciphertext, iv]` (both binary) — requires write
- `server-volatile-broadcast [roomId, ciphertext, iv]` — requires read
- `user-follow [{ userToFollow: { socketId, username }, action: "FOLLOW"|"UNFOLLOW" }]`

Server → client
- `hello [socketId]` — first message after upgrade; `socketId` is 16 random
  bytes base64url, unique per connection
- `init-room []` — immediately after `hello` (upstream Portal answers with `join-room`)
- `first-in-room []`, `new-user [socketId]`, `room-user-change [socketIds]`,
  `client-broadcast [ciphertext, iv]`, `user-follow-room-change [socketIds]`,
  `broadcast-unfollow []` — semantics identical to excalidraw-room
- `error [code]` — `forbidden`, `bad_message`; after `forbidden` on `join-room`
  the server closes with code 4403

Semantics mirror `excalidraw-room/src/index.ts`: joining emits `first-in-room`
to the joiner when alone, otherwise `new-user` to the others; `room-user-change`
goes to the whole room on join and to the remaining members on leave; follow
rooms are named `follow@<socketId>`; a socket may be in one data room at a time
(a second `join-room` leaves the first). Volatile broadcasts may be dropped
when a receiver's send queue exceeds 64 messages; regular broadcasts are never
dropped (slow receivers are disconnected instead). Queues are bounded to 128
frames and 16 MiB per receiver, including any in-flight write. Broadcast recipients
share one immutable encoded frame. Server pings every 25 s and
drops connections silent for 60 s. Message cap 1 MiB per frame for volatile,
`DRAW_MAX_ROOM_BYTES` otherwise.

Write permission for `server-broadcast` is evaluated once at `join-room` and
re-evaluated every 30 s (so revoking a share kicks editors within 30 s: the
server sends `error ["forbidden"]` and closes 4403). Permanent deletion and
trash purging immediately evict room members with 4403.

### Client transport shim (`excalidraw-app/collab/socket.ts`)

Replaces `socket.io-client`. Exposes the subset Portal/Collab use:
`id`, `on(event, fn)`, `once(event, fn)`, `off(event, fn?)`,
`emit(event, ...args)`, `close()`, and the events `connect`, `connect_error`,
`disconnect`. Connects to `wss?://<location.host>/api/ws` (or
`VITE_APP_WS_SERVER_URL` when set). Reconnects with backoff 1 s → 10 s with
jitter, indefinitely, until `close()`. On every (re)connection the server's
`hello` sets `id` and `init-room` triggers Portal's re-join. `connect_error`
fires on the first failed connection attempt (upstream uses it to fall back to
loading the scene over HTTP). Binary args accept `ArrayBuffer` and
`Uint8Array`; received binaries are delivered as `ArrayBuffer` for the first
and `Uint8Array` for the second positional argument of `client-broadcast`,
matching what upstream's handler expects.

### Storage

SQLite at `DATA_DIR/draw.db`, WAL mode, `busy_timeout=5000`, foreign keys on.
Migrations are embedded SQL files applied in order and recorded in
`schema_migrations`.

```
users            id TEXT PK, issuer, subject, email UNIQUE, name, avatar_url, created_at, last_login_at
sessions         token_hash TEXT PK, user_id FK, created_at, expires_at, last_seen_at
collections      id TEXT PK, owner_id FK, name, created_at, updated_at
scenes           id TEXT PK, owner_id FK, name, collection_id FK NULL, room_key,
                 share_mode, created_at, updated_at, deleted_at NULL, thumbnail_updated_at NULL
rooms            id TEXT PK, rev INTEGER, scene_version INTEGER, iv BLOB, ciphertext BLOB,
                 created_by NULL, updated_at
room_versions    room_id, rev, scene_version, iv, ciphertext, created_at   PK(room_id, rev)
snapshots        id TEXT PK, data BLOB, created_at, ip
libraries        user_id TEXT PK, data BLOB (JSON), updated_at
settings         key TEXT PK, value TEXT     -- e.g. first_user_email
imports          source_id TEXT PK, scene_id TEXT, imported_at TEXT -- source provenance
activity         id INTEGER PK, owner_id FK, actor_id FK NULL, kind, scene_id NULL (no FK: rows
                 outlive the scene), scene_name, detail, at   INDEX(owner_id, at), INDEX(scene_id, at)
```

Files on disk: `DATA_DIR/files/rooms/<roomId>/<fileId>`,
`DATA_DIR/files/shareLinks/<jsonId>/<fileId>`, thumbnails
`DATA_DIR/thumbs/<sceneId>.png`. Writes go to a temp file then rename.

Background jobs (in-process tickers): purge trashed scenes older than
`DRAW_TRASH_RETENTION_DAYS`; delete expired sessions; delete ad-hoc rooms and
their files untouched for 90 days; delete activity rows older than 90 days;
sweep orphan `files/rooms/<id>` directories
with neither a scene nor room row when every mtime in the directory is older
than 90 days; delete snapshots older than 365 days.

### Formats the server must understand

Room payload encryption (upstream `encryptData`): AES-GCM, 128-bit key from
the room key (`base64url decode`, 16 bytes), 12-byte random IV, ciphertext as
produced by WebCrypto (plaintext ciphertext followed by the 16-byte tag, which
is exactly Go's `cipher.AEAD.Seal` output). Plaintext for rooms is the UTF-8
JSON array of elements.

File and snapshot blobs (upstream `compressData`): a `concatBuffers` envelope
`[u32 version=1][u32 len][chunk]…` with three chunks: encoding metadata JSON
(`{"version":2,"compression":"pako@1","encryption":"AES-GCM"}`), the IV, and
the ciphertext. The ciphertext decrypts (same AES-GCM) to a zlib (`pako`)
stream that inflates to another `concatBuffers` envelope with two chunks:
metadata JSON and the data bytes. Duplicating a scene re-encrypts only the
outer ciphertext with the new key and a fresh IV; the envelope is rebuilt.

### `import-excalidash`

Reads an ExcaliDash Prisma SQLite database and uploads directory. Source drawing
ids are recorded transactionally in `imports`; repeat runs skip them and report
skipped counts, even after the destination scene is deleted. For each new
drawing: create a scene owned by `--owner` (the user must already exist unless
`--create-owner` is given), named after the drawing, in a collection of the same
name as the drawing's collection (created on demand), with `createdAt`/`updatedAt`
preserved. Elements JSON becomes the room plaintext (encrypt with the new room
key; `sceneVersion` is the sum of element `version` fields, matching upstream
`getSceneVersion`). Files referenced by image elements are looked up in the
drawing's `files` JSON and the uploads directory, wrapped in the upstream file
envelope (metadata `{id, mimeType, created, lastRetrieved}`, data = the
dataURL bytes) and stored under the room. Inspect the actual schema at import
time (`.schema Drawing`, `.schema Collection`) and adapt; do not assume column
names. `--dry-run` prints the plan.

### Server tests

`go test ./...` must cover: auth flow with the dev login; the allowlist rule
(first user wins); CSRF header check; the permission matrix for scenes (owner,
edit, view, none, anonymous, trashed); room create/update/412/history; file
round trip and size caps; snapshot post/get; duplicate re-encrypts correctly
(decrypt with the new key and compare plaintext); a two-client websocket
scenario (join, `first-in-room`, `new-user`, `room-user-change`, broadcast
delivery, volatile delivery, view-only client rejected on `server-broadcast`,
follow rooms, disconnect updates); the SPA fallback and cache headers; and a
Go re-implementation of `compressData` that round-trips test vectors produced
by the TypeScript implementation (`server/internal/crypto/testdata/`,
generated by `scripts/gen-crypto-vectors.mjs`).

## Frontend build

- Node 24, yarn 1.22 (`corepack`), the monorepo's existing workspace layout.
- `excalidraw-app/vite.config.mts`: dev server proxies `/api` (including
  websockets) to `http://127.0.0.1:34729`; `envDir` stays `../`.
- `.env.production` / `.env.development` in the repo root carry:
  `VITE_APP_BACKEND_V2_GET_URL=/api/v2/`, `VITE_APP_BACKEND_V2_POST_URL=/api/v2/post`,
  `VITE_APP_WS_SERVER_URL=` (empty → same origin), `VITE_APP_DISABLE_SENTRY=true`,
  `VITE_APP_ENABLE_TRACKING=false`; the Firebase and `VITE_APP_PLUS_*` variables
  are removed. `VITE_APP_AI_BACKEND` and the library URLs keep upstream values.
- `yarn build:app` → `excalidraw-app/build`. The Nix build copies it to
  `server/web/dist` before `go build`.
- Existing `excalidraw-app/tests` keep passing (`yarn test:app`), updated where
  they referenced Firebase or the removed promos.

## Deployment (spark)

- Nix flake in this repo: `packages.aarch64-linux.default` builds the web app
  with `fetchYarnDeps` + `yarnConfigHook` and the Go binary with
  `buildGoModule`, embedding the web build.
- The nix repo gets `hosts/spark/services/draw.nix`: systemd service `draw`
  (`User=draw`, `StateDirectory=draw`, hardening), environment from a sops
  dotenv with the Google client id and secret, `DRAW_BASE_URL=https://draw.harivan.sh`,
  `DRAW_TRUST_PROXY=1`, Caddy vhost `draw.harivan.sh` → `127.0.0.1:34729`
  (websockets pass through `reverse_proxy` unchanged), nightly `draw backup`
  timer to `/var/backup/draw` with 14-day retention, using `--files DIR` for
  files and thumbnails. The output database and media directory must be new.
  Media uses hard links with a copy fallback across filesystems; source writes
  replace inodes, preserving linked backups. The database and media are separate
  snapshots: quiesce writes for a matching full restore point. Back up `session.key`
  separately. The ExcaliDash containers
  are removed and its data directory kept until the import has run.

## Acceptance (end to end, in a real browser)

1. Sign in, land on an empty dashboard, create a scene, draw, reload: the
   drawing is there, the thumbnail appears on the dashboard within 10 s.
2. Open the same scene in a second tab: cursors, selections and edits appear
   live in both; follow mode works; closing one tab updates the other's
   collaborator list.
3. Set "Anyone with the link can view", open the link in a private window:
   the scene renders in view mode, the viewer's cursor is visible to the
   owner, and the viewer cannot modify anything.
4. Switch to "can edit": the private window can now draw and the owner sees
   it. Switch back to Private: the private window is disconnected within 30 s
   and a reload shows the private-scene page.
5. Export to link from the share dialog opens `/local#json=…` with the
   snapshot, images included.
6. Add an image to a scene; it survives reload and appears in the second tab.
7. Rename, duplicate, move to a collection, trash, restore, delete
   permanently: each reflects immediately in the dashboard.
8. Drop an `.excalidraw` file on the dashboard: a scene appears with the right
   name and content.
9. Every upstream keyboard shortcut listed in the editor's help dialog
   behaves identically to excalidraw.com inside `/s/:id` (spot check: `V R D
   O A L T P E K H`, `Cmd/Ctrl+Z`, `Shift+H/V`, `Cmd+Shift+E`, `Cmd+/`,
   `Alt+Z` zen mode, `Cmd+Shift+P` command palette, `Cmd+F` search).
10. `/local` behaves exactly like excalidraw.com, including starting an
    ad-hoc live session and joining it from a second browser.
