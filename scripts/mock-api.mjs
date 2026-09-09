#!/usr/bin/env node
// In-memory implementation of the draw HTTP API (SPEC.md) for frontend
// development and QA without the Go server. Dev login is always enabled.
//
//   node scripts/mock-api.mjs [--port 34730] [--seed]
//
// State lives in memory only and is lost on exit.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 34730;
const SEED = args.includes("--seed");

const users = new Map(); // id -> user
const sessions = new Map(); // token -> userId
const scenes = new Map(); // id -> scene row
const collections = new Map(); // id -> collection row
const rooms = new Map(); // id -> { rev, sceneVersion, iv, ciphertext, versions: [] }
const files = new Map(); // `${prefix}/${fileId}` -> Buffer
const thumbnails = new Map(); // sceneId -> Buffer
const snapshots = new Map(); // id -> Buffer
const libraries = new Map(); // userId -> JSON string

const hex = (bytes) => randomBytes(bytes).toString("hex");
const roomKey = () => randomBytes(16).toString("base64url");
const now = () => new Date().toISOString();

const publicScene = (s) => ({
  id: s.id,
  name: s.name,
  collectionId: s.collectionId,
  shareMode: s.shareMode,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  deletedAt: s.deletedAt,
  hasThumbnail: thumbnails.has(s.id),
});

const publicCollection = (c) => ({
  id: c.id,
  name: c.name,
  createdAt: c.createdAt,
  sceneCount: [...scenes.values()].filter(
    (s) => s.collectionId === c.id && !s.deletedAt && s.ownerId === c.ownerId,
  ).length,
});

const perm = (user, scene) => {
  if (!scene) {
    return "none";
  }
  if (user && scene.ownerId === user.id) {
    return "owner";
  }
  if (scene.deletedAt) {
    return "none";
  }
  if (scene.shareMode === "edit") {
    return "edit";
  }
  if (scene.shareMode === "view") {
    return "view";
  }
  return "none";
};
const canWrite = (p) => p === "owner" || p === "edit";
const canRead = (p) => canWrite(p) || p === "view";

// Minimal PNG encoder (RGBA, no filtering) so seeded scenes have thumbnails.
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) {
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const encodePNG = (width, height, paint) => {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const sketchThumbnail = (seed) => {
  const rnd = (() => {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();
  const shapes = [];
  const palette = [
    [105, 101, 219],
    [224, 49, 49],
    [43, 138, 62],
    [230, 119, 0],
    [25, 113, 194],
  ];
  const count = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < count; i++) {
    shapes.push({
      x: 40 + rnd() * 420,
      y: 40 + rnd() * 240,
      w: 60 + rnd() * 160,
      h: 40 + rnd() * 110,
      color: palette[Math.floor(rnd() * palette.length)],
      round: rnd() > 0.5,
    });
  }
  return encodePNG(640, 400, (x, y) => {
    for (const s of shapes) {
      const inX = x >= s.x && x <= s.x + s.w;
      const inY = y >= s.y && y <= s.y + s.h;
      if (!inX || !inY) {
        continue;
      }
      if (s.round) {
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        const d = ((x - cx) / (s.w / 2)) ** 2 + ((y - cy) / (s.h / 2)) ** 2;
        if (d > 1) {
          continue;
        }
        if (d > 0.85) {
          return [...s.color, 255];
        }
        continue;
      }
      const edge =
        x - s.x < 3 || s.x + s.w - x < 3 || y - s.y < 3 || s.y + s.h - y < 3;
      if (edge) {
        return [...s.color, 255];
      }
    }
    return [255, 255, 255, 255];
  });
};

const seed = () => {
  const user = ensureUser("hari@example.com", "Hari");
  const work = createCollection(user, "Work");
  const ideas = createCollection(user, "Ideas");
  const names = [
    ["System architecture", work.id, 2],
    ["Auth flow", work.id, 50],
    ["Deploy pipeline", work.id, 400],
    ["Garden layout", ideas.id, 1500],
    ["Wardrobe", ideas.id, 4000],
    ["Untitled", null, 9000],
    [
      "Sprint retro notes with a very long name that should truncate",
      null,
      20000,
    ],
    ["Kitchen remodel", ideas.id, 90000],
  ];
  names.forEach(([name, collectionId, minutesAgo], i) => {
    const s = createScene(user, { name, collectionId });
    s.updatedAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
    s.createdAt = new Date(
      Date.now() - (minutesAgo + 60) * 60000,
    ).toISOString();
    if (i % 3 !== 2) {
      thumbnails.set(s.id, sketchThumbnail(i + 7));
    }
    if (i === 1) {
      s.shareMode = "view";
    }
  });
  const trashed = createScene(user, { name: "Old whiteboard" });
  trashed.deletedAt = now();
  thumbnails.set(trashed.id, sketchThumbnail(99));
};

const ensureUser = (email, name) => {
  for (const u of users.values()) {
    if (u.email === email) {
      return u;
    }
  }
  const user = {
    id: hex(8),
    email,
    name: name || email.split("@")[0],
    avatarUrl: "",
  };
  users.set(user.id, user);
  return user;
};

const createCollection = (user, name) => {
  const c = { id: hex(8), ownerId: user.id, name, createdAt: now() };
  collections.set(c.id, c);
  return c;
};

const createScene = (user, { name, collectionId }) => {
  const s = {
    id: hex(10),
    ownerId: user.id,
    name: name || "Untitled",
    collectionId: collectionId || null,
    shareMode: "private",
    roomKey: roomKey(),
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
  };
  scenes.set(s.id, s);
  return s;
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const parseCookies = (req) => {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) {
      out[k] = decodeURIComponent(v.join("="));
    }
  }
  return out;
};

const send = (res, status, body, headers = {}) => {
  if (body === undefined || body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(json);
};
const fail = (res, status, error, message) =>
  send(res, status, { error, message: message || error });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  const cookies = parseCookies(req);
  const userId = sessions.get(cookies.draw_session);
  const user = userId ? users.get(userId) : null;
  const body = ["POST", "PUT", "PATCH"].includes(method)
    ? await readBody(req)
    : Buffer.alloc(0);
  const json = () => {
    try {
      return body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return null;
    }
  };
  const requireUser = () => {
    if (!user) {
      fail(res, 401, "unauthorized", "Sign in required");
      return false;
    }
    return true;
  };

  // eslint-disable-next-line no-console
  console.log(method, path);

  let m;
  if (path === "/api/health") {
    return send(res, 200, { ok: true, version: "mock" });
  }
  if (path === "/api/auth/config") {
    return send(res, 200, { devLogin: true, provider: "Google" });
  }
  if (path === "/api/auth/me") {
    return user ? send(res, 200, { user }) : fail(res, 401, "unauthorized");
  }
  if (path === "/api/auth/dev" && method === "GET") {
    // Convenience for screenshot tooling: sign in and land on `next`.
    const u = ensureUser(
      url.searchParams.get("email") || "hari@example.com",
      "Hari",
    );
    const token = hex(16);
    sessions.set(token, u.id);
    return send(res, 302, null, {
      "Set-Cookie": `draw_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
      Location: url.searchParams.get("next") || "/",
    });
  }
  if (path === "/api/auth/dev" && method === "POST") {
    const data = json();
    if (!data || !data.email) {
      return fail(res, 400, "bad_request", "email required");
    }
    const u = ensureUser(data.email, data.name);
    const token = hex(16);
    sessions.set(token, u.id);
    return send(res, 204, null, {
      "Set-Cookie": `draw_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
    });
  }
  if (path === "/api/auth/oidc/start") {
    // No real provider in the mock: land on the error page so the UI can be seen.
    return send(res, 302, null, {
      Location: `/login?error=oidc&next=${encodeURIComponent(
        url.searchParams.get("next") || "/",
      )}`,
    });
  }
  if (path === "/api/auth/logout-get") {
    sessions.delete(cookies.draw_session);
    return send(res, 302, null, {
      "Set-Cookie": "draw_session=; Path=/; Max-Age=0",
      Location: url.searchParams.get("next") || "/login",
    });
  }
  if (path === "/api/auth/logout" && method === "POST") {
    sessions.delete(cookies.draw_session);
    return send(res, 204, null, {
      "Set-Cookie": "draw_session=; Path=/; Max-Age=0",
    });
  }

  if (path === "/api/scenes" && method === "GET") {
    if (!requireUser()) {
      return;
    }
    const collection = url.searchParams.get("collection") || "all";
    const trash = url.searchParams.get("trash") === "1";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const sort = url.searchParams.get("sort") || "updated";
    const order = url.searchParams.get("order") || "desc";
    let list = [...scenes.values()].filter(
      (s) => s.ownerId === user.id && !!s.deletedAt === trash,
    );
    if (collection === "none") {
      list = list.filter((s) => s.collectionId === null);
    } else if (collection !== "all") {
      list = list.filter((s) => s.collectionId === collection);
    }
    if (q) {
      list = list.filter((s) => s.name.toLowerCase().includes(q));
    }
    const key = { updated: "updatedAt", created: "createdAt", name: "name" }[
      sort
    ];
    list.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const c =
        key === "name"
          ? av.localeCompare(bv, undefined, { sensitivity: "base" })
          : av < bv
          ? -1
          : av > bv
          ? 1
          : 0;
      return order === "asc" ? c : -c;
    });
    return send(res, 200, { scenes: list.map(publicScene) });
  }
  if (path === "/api/scenes" && method === "POST") {
    if (!requireUser()) {
      return;
    }
    const data = json() || {};
    const s = createScene(user, data);
    return send(res, 201, {
      scene: publicScene(s),
      permission: "owner",
      roomKey: s.roomKey,
    });
  }
  if ((m = path.match(/^\/api\/scenes\/([^/]+)$/))) {
    const s = scenes.get(m[1]);
    if (!s) {
      return fail(res, 404, "not_found");
    }
    const p = perm(user, s);
    if (method === "GET") {
      if (p === "none") {
        return user
          ? fail(res, 403, "forbidden")
          : fail(res, 401, "unauthorized");
      }
      return send(res, 200, {
        scene: publicScene(s),
        permission: p,
        roomKey: s.roomKey,
      });
    }
    if (p !== "owner") {
      return fail(res, 403, "forbidden");
    }
    if (method === "PATCH") {
      const data = json() || {};
      if (typeof data.name === "string") {
        s.name = data.name.trim() || "Untitled";
      }
      if ("collectionId" in data) {
        s.collectionId = data.collectionId || null;
      }
      if (["private", "view", "edit"].includes(data.shareMode)) {
        s.shareMode = data.shareMode;
      }
      return send(res, 200, publicScene(s));
    }
    if (method === "DELETE") {
      if (url.searchParams.get("permanent") === "1") {
        scenes.delete(s.id);
        rooms.delete(s.id);
        thumbnails.delete(s.id);
        return send(res, 204);
      }
      s.deletedAt = now();
      return send(res, 204);
    }
  }
  if (
    (m = path.match(/^\/api\/scenes\/([^/]+)\/restore$/)) &&
    method === "POST"
  ) {
    const s = scenes.get(m[1]);
    if (!s || perm(user, s) !== "owner") {
      return fail(res, 404, "not_found");
    }
    s.deletedAt = null;
    return send(res, 200, publicScene(s));
  }
  if (
    (m = path.match(/^\/api\/scenes\/([^/]+)\/duplicate$/)) &&
    method === "POST"
  ) {
    const s = scenes.get(m[1]);
    if (!s || perm(user, s) !== "owner") {
      return fail(res, 404, "not_found");
    }
    const data = json() || {};
    const copy = createScene(user, {
      name: data.name || `${s.name} (copy)`,
      collectionId: s.collectionId,
    });
    // The mock keeps the same key so the payload stays decryptable.
    copy.roomKey = s.roomKey;
    if (rooms.has(s.id)) {
      rooms.set(copy.id, { ...rooms.get(s.id), versions: [] });
    }
    if (thumbnails.has(s.id)) {
      thumbnails.set(copy.id, thumbnails.get(s.id));
    }
    return send(res, 201, {
      scene: publicScene(copy),
      permission: "owner",
      roomKey: copy.roomKey,
    });
  }
  if ((m = path.match(/^\/api\/scenes\/([^/]+)\/thumbnail$/))) {
    const s = scenes.get(m[1]);
    const p = perm(user, s);
    if (method === "PUT") {
      if (!canWrite(p)) {
        return fail(res, 403, "forbidden");
      }
      if (body.length > 512 * 1024) {
        return fail(res, 413, "too_large");
      }
      thumbnails.set(s.id, body);
      return send(res, 204);
    }
    if (!canRead(p)) {
      return fail(res, 404, "not_found");
    }
    const png = thumbnails.get(s.id);
    if (!png) {
      return fail(res, 404, "not_found");
    }
    return send(res, 200, png, {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=60",
    });
  }

  if (path === "/api/collections") {
    if (!requireUser()) {
      return;
    }
    if (method === "GET") {
      const list = [...collections.values()]
        .filter((c) => c.ownerId === user.id)
        .sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { collections: list.map(publicCollection) });
    }
    if (method === "POST") {
      const data = json() || {};
      if (!data.name || !data.name.trim()) {
        return fail(res, 400, "bad_request", "name required");
      }
      return send(
        res,
        201,
        publicCollection(createCollection(user, data.name.trim())),
      );
    }
  }
  if ((m = path.match(/^\/api\/collections\/([^/]+)$/))) {
    if (!requireUser()) {
      return;
    }
    const c = collections.get(m[1]);
    if (!c || c.ownerId !== user.id) {
      return fail(res, 404, "not_found");
    }
    if (method === "PATCH") {
      const data = json() || {};
      if (data.name && data.name.trim()) {
        c.name = data.name.trim();
      }
      return send(res, 200, publicCollection(c));
    }
    if (method === "DELETE") {
      for (const s of scenes.values()) {
        if (s.collectionId === c.id) {
          s.collectionId = null;
        }
      }
      collections.delete(c.id);
      return send(res, 204);
    }
  }

  if (path === "/api/library") {
    if (!requireUser()) {
      return;
    }
    if (method === "GET") {
      const data = libraries.get(user.id);
      return data
        ? send(res, 200, Buffer.from(data), {
            "Content-Type": "application/json",
          })
        : send(res, 204);
    }
    if (method === "PUT") {
      libraries.set(user.id, body.toString("utf8"));
      return send(res, 204);
    }
  }

  if ((m = path.match(/^\/api\/rooms\/([^/]+)$/))) {
    const roomId = m[1];
    const scene = scenes.get(roomId);
    const p = scene
      ? perm(user, scene)
      : user
      ? "edit"
      : rooms.has(roomId)
      ? "edit"
      : "view";
    const room = rooms.get(roomId);
    if (method === "GET") {
      if (!canRead(p)) {
        return fail(res, 403, "forbidden");
      }
      if (!room) {
        return fail(res, 404, "not_found");
      }
      const { versions: _versions, ...payload } = room;
      return send(res, 200, payload, { ETag: `"${room.rev}"` });
    }
    if (method === "PUT") {
      if (!canWrite(p)) {
        return fail(res, 403, "forbidden");
      }
      const data = json();
      if (
        !data ||
        typeof data.iv !== "string" ||
        typeof data.ciphertext !== "string"
      ) {
        return fail(res, 400, "bad_request");
      }
      const ifMatch = req.headers["if-match"];
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === "*") {
        if (room) {
          return fail(res, 412, "precondition_failed");
        }
        const created = {
          rev: 1,
          sceneVersion: data.sceneVersion || 0,
          iv: data.iv,
          ciphertext: data.ciphertext,
          versions: [],
        };
        rooms.set(roomId, created);
        if (scene) {
          scene.updatedAt = now();
        }
        return send(res, 201, { rev: 1 });
      }
      if (!room || ifMatch !== `"${room.rev}"`) {
        return fail(res, 412, "precondition_failed");
      }
      room.versions.push({
        rev: room.rev,
        sceneVersion: room.sceneVersion,
        createdAt: now(),
        bytes: room.ciphertext.length,
      });
      room.rev += 1;
      room.sceneVersion = data.sceneVersion || 0;
      room.iv = data.iv;
      room.ciphertext = data.ciphertext;
      if (scene) {
        scene.updatedAt = now();
      }
      return send(res, 200, { rev: room.rev });
    }
  }
  if ((m = path.match(/^\/api\/rooms\/([^/]+)\/versions$/))) {
    const room = rooms.get(m[1]);
    return send(res, 200, { versions: room ? room.versions : [] });
  }

  if (
    (m = path.match(/^\/api\/files\/(rooms|shareLinks)\/([^/]+)\/([^/]+)$/))
  ) {
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    if (method === "PUT") {
      if (body.length > 6 * 1024 * 1024) {
        return fail(res, 413, "too_large");
      }
      files.set(key, body);
      return send(res, 204);
    }
    const data = files.get(key);
    return data
      ? send(res, 200, data, { "Content-Type": "application/octet-stream" })
      : fail(res, 404, "not_found");
  }

  if (path === "/api/v2/post" && method === "POST") {
    const id = hex(10);
    snapshots.set(id, body);
    return send(res, 200, { id });
  }
  if ((m = path.match(/^\/api\/v2\/([^/]+)$/))) {
    const data = snapshots.get(m[1]);
    return data
      ? send(res, 200, data, { "Content-Type": "application/octet-stream" })
      : fail(res, 404, "not_found");
  }

  fail(res, 404, "not_found", `no route for ${method} ${path}`);
});

if (SEED) {
  seed();
}

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`mock draw API on http://127.0.0.1:${PORT} (seeded: ${SEED})`);
});
