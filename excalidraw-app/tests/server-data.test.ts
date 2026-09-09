import { vi } from "vitest";

import { ApiError } from "../data/api";
import {
  loadFilesFromServer,
  normalizeFilePrefix,
  saveFilesToServer,
  saveToServer,
  loadFromServer,
} from "../data/server";

import type { SyncableExcalidrawElement } from "../data";

const roomKey = "sTdLvMC_M3V8_vGa3UVRDg";

// AES-GCM is unavailable in jsdom; the payload format is what matters here
vi.mock("@excalidraw/excalidraw/data/encryption", () => ({
  encryptData: async (
    _key: string,
    data: Uint8Array,
  ): Promise<{ encryptedBuffer: ArrayBuffer; iv: Uint8Array }> => ({
    encryptedBuffer: data.slice().buffer,
    iv: new Uint8Array(12),
  }),
  decryptData: async (_iv: Uint8Array, encrypted: ArrayBuffer) => encrypted,
}));

const element = (id: string, version: number) =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    version,
    versionNonce: 1,
    isDeleted: false,
    index: "a0",
    updated: Date.now(),
    strokeColor: "#000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    angle: 0,
    seed: 1,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: null,
    link: null,
    locked: false,
  } as unknown as SyncableExcalidrawElement);

const makePortal = () => ({
  roomId: "room-1",
  roomKey,
  socket: {} as any,
});

const jsonResponse = (status: number, body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("saveToServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the room with If-None-Match when it does not exist", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (init.method === undefined || init.method === "GET") {
          return jsonResponse(404, { error: "not_found", message: "" });
        }
        return jsonResponse(201, { rev: 1 });
      }),
    );

    const portal = makePortal() as any;
    const stored = await saveToServer(portal, [element("A", 1)], {} as any);

    expect(stored?.map((el) => el.id)).toEqual(["A"]);
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(put.url).toBe("/api/rooms/room-1");
    expect((put.init.headers as Record<string, string>)["If-None-Match"]).toBe(
      "*",
    );
    const body = JSON.parse(put.init.body as string);
    expect(body.sceneVersion).toBe(1);
    expect(typeof body.iv).toBe("string");
    expect(typeof body.ciphertext).toBe("string");
  });

  it("retries after a 412 with the fresh revision and reconciles", async () => {
    let rev = 3;
    let puts = 0;
    const remote = [element("B", 5)];
    const encode = (elements: unknown) =>
      btoa(
        String.fromCharCode(
          ...new TextEncoder().encode(JSON.stringify(elements)),
        ),
      );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === undefined || init.method === "GET") {
          return jsonResponse(200, {
            rev,
            sceneVersion: 5,
            iv: btoa("\0".repeat(12)),
            ciphertext: encode(remote),
          });
        }
        puts++;
        const ifMatch = (init.headers as Record<string, string>)["If-Match"];
        if (puts === 1) {
          rev = 4;
          return jsonResponse(412, {
            error: "precondition_failed",
            message: "",
          });
        }
        expect(ifMatch).toBe('"4"');
        return jsonResponse(200, { rev: 5 });
      }),
    );

    const portal = makePortal() as any;
    const stored = await saveToServer(portal, [element("A", 1)], {
      selectedElementIds: {},
    } as any);

    expect(puts).toBe(2);
    expect(stored?.map((el) => el.id).sort()).toEqual(["A", "B"]);
  });

  it("gives up after repeated conflicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === undefined || init.method === "GET") {
          return jsonResponse(404, { error: "not_found", message: "" });
        }
        return jsonResponse(412, { error: "precondition_failed", message: "" });
      }),
    );
    await expect(
      saveToServer(makePortal() as any, [element("A", 1)], {} as any),
    ).rejects.toThrow(/concurrent/);
  });

  it("surfaces other server errors as ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === undefined || init.method === "GET") {
          return jsonResponse(404, { error: "not_found", message: "" });
        }
        return jsonResponse(403, { error: "forbidden", message: "nope" });
      }),
    );
    await expect(
      saveToServer(makePortal() as any, [element("A", 1)], {} as any),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("loadFromServer", () => {
  it("returns null for a room that was never saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: "not_found", message: "" })),
    );
    expect(await loadFromServer("room-1", roomKey, null)).toBeNull();
  });
});

describe("file prefixes", () => {
  it("normalizes legacy firebase-style prefixes", () => {
    expect(normalizeFilePrefix("files/rooms/abc")).toBe("rooms/abc");
    expect(normalizeFilePrefix("/files/shareLinks/xyz/")).toBe(
      "shareLinks/xyz",
    );
    expect(normalizeFilePrefix("rooms/abc")).toBe("rooms/abc");
  });

  it("loads and saves files under /api/files/<prefix>/<id>", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(null, { status: 404 });
      }),
    );
    await loadFilesFromServer("files/rooms/room-1", roomKey, ["file-a" as any]);
    await saveFilesToServer({
      prefix: "/files/rooms/room-1",
      files: [{ id: "file-b" as any, buffer: new Uint8Array([1]) }],
    });
    expect(urls).toEqual([
      "/api/files/rooms/room-1/file-a",
      "/api/files/rooms/room-1/file-b",
    ]);
  });
});
