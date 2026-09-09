# draw server

Go 1.26 backend for the HTTP and WebSocket contracts in ../SPEC.md. Direct
dependencies are SQLite (modernc), coder/websocket, coreos/go-oidc and oauth2.
The editor is embedded from web/dist; the committed index.html is a placeholder.

From this directory:

```sh
go build -o draw ./cmd/draw
DRAW_DEV_LOGIN=1 DRAW_DATA_DIR=/tmp/draw-dev ./draw serve
go vet ./...
go test ./...
go test -race ./...
```

The default command is serve. Listen defaults to 127.0.0.1:34729. For curl writes,
send Origin: http://localhost:34729 and retain the draw_session cookie.
Frontend builds replace web/dist before compiling; preserve the Go embed file.

## Configuration

Serve flags override environment variables. Boolean flags use --flag=true/false;
environment booleans accept 1/0. Relative paths resolve against the working directory.

| Environment | Flag | Default |
| --- | --- | --- |
| DRAW_LISTEN | --listen | 127.0.0.1:34729 |
| DRAW_DATA_DIR | --data-dir | ./data |
| DRAW_BASE_URL | --base-url | http://localhost:34729 |
| OIDC_ISSUER_URL | --oidc-issuer-url | https://accounts.google.com |
| OIDC_CLIENT_ID | --oidc-client-id | required outside dev mode |
| OIDC_CLIENT_SECRET | --oidc-client-secret | required outside dev mode |
| OIDC_REDIRECT_URI | --oidc-redirect-uri | BASE_URL/api/auth/oidc/callback |
| DRAW_ALLOWED_EMAILS | --allowed-emails | empty: first successful account wins |
| DRAW_OPEN_SIGNUP | --open-signup | 0 |
| DRAW_DEV_LOGIN | --dev-login | 0 |
| DRAW_TRUST_PROXY | --trust-proxy | 0 |
| DRAW_SESSION_KEY_FILE | --session-key-file | DATA_DIR/session.key |
| DRAW_MAX_ROOM_BYTES | --max-room-bytes | 8388608 |
| DRAW_MAX_FILE_BYTES | --max-file-bytes | 6291456 |
| DRAW_TRASH_RETENTION_DAYS | --trash-retention-days | 30 |
| DRAW_ROOM_HISTORY | --room-history | 20 |

Production needs DRAW_BASE_URL=https://draw.harivan.sh, a writable DRAW_DATA_DIR,
OIDC_CLIENT_ID and OIDC_CLIENT_SECRET. Set DRAW_TRUST_PROXY=1 behind Caddy, which
must supply trusted forwarding headers. Client IP selection prefers CF-Connecting-IP,
then the rightmost valid X-Forwarded-For IP after stripping private/loopback hops.
The proxy must overwrite these headers with trusted values. Leave DRAW_DEV_LOGIN
disabled. DRAW_OPEN_SIGNUP overrides the allowlist. session.key is created as 32 random bytes with mode 0600.

The draw_session cookie is HttpOnly, SameSite=Lax, Path=/, Secure for HTTPS, with
30-day sliding expiry, refreshed only after last_seen_at is older than one hour.
Only its SHA-256 hash is stored. draw_oidc is a signed, 10-minute state/nonce/next
cookie used during login; next fragments are stripped. API responses default to
no-store; files, snapshots and thumbnails override this as specified.

POST/PUT/PATCH/DELETE require either a matching Origin or Sec-Fetch-Site:
same-origin/none. WebSocket upgrades always require an exact matching Origin.
A Vite proxy must preserve the browser Origin; set DRAW_BASE_URL to the development
frontend's origin when serving the frontend on a separate development port.

Errors contain error and message:

| Status | error |
| --- | --- |
| 400 | bad_request |
| 401 | unauthorized |
| 403 | forbidden, not_allowed (dev-login allowlist) |
| 404 | not_found |
| 412 | precondition_failed |
| 413 | too_large |
| 426 | bad_request (missing WebSocket upgrade) |
| 429 | rate_limited |
| 500 | internal_error |

POST /api/v2/post 413 responses also include error_class: "RequestTooLargeError"
for the upstream export client. Snapshot files are immutable: repeated PUTs return
204 and preserve the first published bytes. Static font and manifest types are
registered explicitly for hosts without /etc/mime.types.

OIDC email collisions with another subject are logged and return not_allowed;
issuer+subject remains the identity key. OIDC failures redirect to
/login?error=oidc or /login?error=not_allowed.
WebSocket error events contain forbidden or bad_message. Forbidden joins and
revoked access close with 4403; permanent deletion and trash purging evict members
with 4403 immediately. Shutdown closes with 1001. Anonymous ad-hoc peers can
broadcast before the first save; HTTP creation still requires a signed-in user.
Each receiver is limited to 128 queued frames and 16 MiB including in-flight writes;
broadcasts share one encoded frame. Volatile traffic drops under pressure, while
regular traffic disconnects slow receivers. Permission queries do not hold the
hub mutex. All frames use the binary version-1 transport, including hello and init-room. Room saves require
If-None-Match: * or If-Match: "<rev>"; the returned rev and ETag advance atomically.

## Import and backup

```sh
DRAW_DATA_DIR=/var/lib/draw ./draw import-excalidash \
  --db /path/to/excalidash/dev.db --uploads /path/to/uploads \
  --owner owner@example.com --dry-run
DRAW_DATA_DIR=/var/lib/draw ./draw import-excalidash \
  --db /path/to/excalidash/dev.db --uploads /path/to/uploads \
  --owner owner@example.com
DRAW_DATA_DIR=/var/lib/draw ./draw backup /path/to/new-backup.sqlite \
  --files /path/to/new-media-backup
```

Sign in once before importing, or pass --create-owner. That placeholder identity
is claimed by the first permitted verified login with the same email. The
importer reads the source SQLite database in read-only mode, reports its actual
Drawing/Collection schemas, recognizes camelCase and snake_case columns, and
validates all drawings/files before committing. It supports inline data URLs,
local upload references, and DrawingFile database blobs. External/S3 files must
be present in the supplied uploads tree; no remote resources are fetched.
Unknown layouts, unsupported drawing engines, and missing images fail explicitly.
Each run skips drawings whose ExcaliDash source id is already in the imports table
and reports imported/skipped counts (also in dry runs). Provenance is committed
with the scene and survives deletion, so rerunning cannot resurrect deleted imports.
Ids identify drawings across source database paths; an already-imported drawing
is skipped even if its old uploads are no longer available. Existing imports made
before this migration have no recorded source id and cannot be deduplicated
retroactively.
--dry-run creates no users/scenes/files, though opening a new destination initializes
its database schema. --data-dir also overrides the import destination.

Backup uses VACUUM INTO and refuses an existing output file. Optional --files DIR
creates a new directory containing files/ and thumbs/, using hard links or copying
across filesystems. The directory must be outside DATA_DIR and must not exist.
Published files are replaced atomically, so later uploads cannot change linked
backups. Restore those trees into DATA_DIR alongside the database; preserve
session.key separately. The database and media are captured separately: quiesce
writes if the nightly timer requires a matching full restore point. A file-backup
failure returns an error while leaving the completed database backup in place.

Cleanup runs at startup and hourly: expired sessions, expired trash, ad-hoc rooms
idle for 90 days, and snapshots older than 365 days. Orphan files/rooms directories
with neither a scene nor a room row are removed only when the newest mtime in the
directory is older than 90 days, including file and directory mtimes.

## Contract choices and validation

No frontend files or upstream editor behavior change here. For details the spec
leaves open: room history bytes includes IV plus ciphertext; collection counts
exclude trash; duplication requires a signed-in reader and clears collectionId
when copying another owner's scene, keeping collections owner-scoped. Defensive
envelope inflation and individual importer upload reads are capped at 64 MiB.

Crypto fixtures are regenerated from the repository root with
node scripts/gen-crypto-vectors.mjs. Fixed fixture keys/IVs are only test inputs.
Go's zlib output is interoperable with pako but need not use identical DEFLATE blocks.

Tests cover dev and mock-provider OIDC login, allowlist races, CSRF, permissions,
CRUD, concurrent revision conflicts and history pruning, file/snapshot/thumbnail
handling, duplication, library bytes, static caching, rate limits, WebSocket
framing/membership/follow/revocation/shutdown, importer variants, cleanup and backup.

Live verification used curl against port 34729 and a standalone two-client Go
WebSocket client, plus VACUUM INTO and SIGTERM/1001 shutdown. Google credentials,
a real ExcaliDash database, the built frontend and browser acceptance remain
deployment integration checks.
