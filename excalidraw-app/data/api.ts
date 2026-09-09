/**
 * Typed client for the draw server (`server/`). Mirrors SPEC.md "HTTP API".
 * Every function throws `ApiError` on a non-2xx response.
 */

export type ShareMode = "private" | "view" | "edit";
export type Permission = "owner" | "edit" | "view";

export type User = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
};

export type SceneMeta = {
  id: string;
  name: string;
  collectionId: string | null;
  shareMode: ShareMode;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hasThumbnail: boolean;
};

export type SceneAccess = {
  scene: SceneMeta;
  permission: Permission;
  roomKey: string;
};

export type Collection = {
  id: string;
  name: string;
  createdAt: string;
  sceneCount: number;
};

export type RoomPayload = {
  rev: number;
  sceneVersion: number;
  /** base64 (standard, padded) */
  iv: string;
  /** base64 (standard, padded) */
  ciphertext: string;
};

export type RoomVersion = {
  rev: number;
  sceneVersion: number;
  createdAt: string;
  bytes: number;
};

export type AuthConfig = { devLogin: boolean; provider: string };

export type SceneListQuery = {
  collection?: string | "none" | "all";
  trash?: boolean;
  q?: string;
  sort?: "updated" | "name" | "created";
  order?: "asc" | "desc";
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const API_BASE = "/api";

const request = async (
  method: string,
  path: string,
  init: {
    json?: unknown;
    body?: BodyInit;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<Response> => {
  const headers: Record<string, string> = { ...(init.headers || {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body,
    credentials: "same-origin",
    signal: init.signal,
  });
  if (!response.ok) {
    let code = "http_error";
    let message = response.statusText;
    try {
      const data = await response.json();
      if (data && typeof data.error === "string") {
        code = data.error;
      }
      if (data && typeof data.message === "string") {
        message = data.message;
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, code, message);
  }
  return response;
};

const json = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

const query = (
  params: Record<string, string | number | boolean | undefined>,
) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const str = search.toString();
  return str ? `?${str}` : "";
};

export const api = {
  auth: {
    config: () =>
      request("GET", "/auth/config").then((response) =>
        json<AuthConfig>(response),
      ),
    /** Resolves to `null` when signed out. */
    me: async (): Promise<User | null> => {
      try {
        const { user } = await request("GET", "/auth/me").then((response) =>
          json<{ user: User }>(response),
        );
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          return null;
        }
        throw error;
      }
    },
    /** URL to navigate to (full page) to start the OIDC flow. */
    oidcStartUrl: (next: string) =>
      `${API_BASE}/auth/oidc/start${query({ next })}`,
    logout: () => request("POST", "/auth/logout").then(() => undefined),
    devLogin: (email: string, name?: string) =>
      request("POST", "/auth/dev", { json: { email, name } }).then(
        () => undefined,
      ),
  },

  scenes: {
    list: (params: SceneListQuery = {}) =>
      request(
        "GET",
        `/scenes${query({
          collection: params.collection,
          trash: params.trash ? 1 : undefined,
          q: params.q,
          sort: params.sort,
          order: params.order,
        })}`,
      ).then((response) => json<{ scenes: SceneMeta[] }>(response)),
    create: (data: { name?: string; collectionId?: string | null } = {}) =>
      request("POST", "/scenes", { json: data }).then((response) =>
        json<SceneAccess>(response),
      ),
    get: (id: string) =>
      request("GET", `/scenes/${id}`).then((response) =>
        json<SceneAccess>(response),
      ),
    update: (
      id: string,
      data: {
        name?: string;
        collectionId?: string | null;
        shareMode?: ShareMode;
      },
    ) =>
      request("PATCH", `/scenes/${id}`, { json: data }).then((response) =>
        json<SceneMeta>(response),
      ),
    trash: (id: string) =>
      request("DELETE", `/scenes/${id}`).then(() => undefined),
    deletePermanently: (id: string) =>
      request("DELETE", `/scenes/${id}?permanent=1`).then(() => undefined),
    restore: (id: string) =>
      request("POST", `/scenes/${id}/restore`).then((response) =>
        json<SceneMeta>(response),
      ),
    duplicate: (id: string, name?: string) =>
      request("POST", `/scenes/${id}/duplicate`, { json: { name } }).then(
        (response) => json<SceneAccess>(response),
      ),
    putThumbnail: (id: string, png: Blob) =>
      request("PUT", `/scenes/${id}/thumbnail`, {
        body: png,
        headers: { "Content-Type": "image/png" },
      }).then(() => undefined),
    thumbnailUrl: (id: string, updatedAt?: string) =>
      `${API_BASE}/scenes/${id}/thumbnail${query({ v: updatedAt })}`,
  },

  collections: {
    list: () =>
      request("GET", "/collections").then((response) =>
        json<{ collections: Collection[] }>(response),
      ),
    create: (name: string) =>
      request("POST", "/collections", { json: { name } }).then((response) =>
        json<Collection>(response),
      ),
    rename: (id: string, name: string) =>
      request("PATCH", `/collections/${id}`, { json: { name } }).then(
        (response) => json<Collection>(response),
      ),
    remove: (id: string) =>
      request("DELETE", `/collections/${id}`).then(() => undefined),
  },

  library: {
    /** Resolves to `null` when the user has no stored library. */
    get: async <T = unknown>(): Promise<T | null> => {
      const response = await request("GET", "/library");
      if (response.status === 204) {
        return null;
      }
      return (await response.json()) as T;
    },
    put: (data: unknown) =>
      request("PUT", "/library", { json: data }).then(() => undefined),
  },

  rooms: {
    /** Resolves to `null` when the room has never been saved (404). */
    get: async (roomId: string): Promise<RoomPayload | null> => {
      try {
        return await request("GET", `/rooms/${roomId}`).then((response) =>
          json<RoomPayload>(response),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    /**
     * `rev === null` creates (If-None-Match: *), otherwise updates with
     * If-Match. Throws `ApiError` with status 412 on a concurrent update.
     */
    put: (
      roomId: string,
      payload: Omit<RoomPayload, "rev">,
      rev: number | null,
    ) =>
      request("PUT", `/rooms/${roomId}`, {
        json: payload,
        headers:
          rev === null ? { "If-None-Match": "*" } : { "If-Match": `"${rev}"` },
      }).then((response) => json<{ rev: number }>(response)),
    versions: (roomId: string) =>
      request("GET", `/rooms/${roomId}/versions`).then((response) =>
        json<{ versions: RoomVersion[] }>(response),
      ),
    version: (roomId: string, rev: number) =>
      request("GET", `/rooms/${roomId}/versions/${rev}`).then((response) =>
        json<RoomPayload>(response),
      ),
  },

  files: {
    /** `prefix` is `rooms/<roomId>` or `shareLinks/<jsonId>`. */
    put: (prefix: string, fileId: string, bytes: Uint8Array) =>
      request("PUT", `/files/${prefix}/${fileId}`, {
        body: bytes as BodyInit,
        headers: { "Content-Type": "application/octet-stream" },
      }).then(() => undefined),
    url: (prefix: string, fileId: string) =>
      `${API_BASE}/files/${prefix}/${fileId}`,
  },

  snapshots: {
    post: (bytes: Uint8Array) =>
      request("POST", "/v2/post", {
        body: bytes as BodyInit,
        headers: { "Content-Type": "application/octet-stream" },
      }).then((response) => json<{ id: string }>(response)),
    url: (id: string) => `${API_BASE}/v2/${id}`,
  },
};

export const isApiError = (
  error: unknown,
  status?: number,
): error is ApiError =>
  error instanceof ApiError &&
  (status === undefined || error.status === status);
