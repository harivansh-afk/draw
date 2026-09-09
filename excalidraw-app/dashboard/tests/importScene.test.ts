import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bytesToBase64,
  importSceneFile,
  isExcalidrawFile,
} from "../importScene";

const base64ToBytes = (base64: string) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// A real 128-bit AES-GCM key exported the way upstream does (JWK `k`).
const ROOM_KEY = "sTdLvMC_M3V8_vGa3UVRDg";

describe("bytesToBase64", () => {
  it("matches btoa for small and large buffers", () => {
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
    expect(bytesToBase64(big.buffer)).toBe(bytesToBase64(big));
  });
});

describe("isExcalidrawFile", () => {
  it("accepts .excalidraw and JSON files", () => {
    expect(isExcalidrawFile(new File([""], "a.excalidraw"))).toBe(true);
    expect(isExcalidrawFile(new File([""], "a.excalidraw.json"))).toBe(true);
    expect(
      isExcalidrawFile(new File([""], "a.json", { type: "application/json" })),
    ).toBe(true);
    expect(
      isExcalidrawFile(new File([""], "a.png", { type: "image/png" })),
    ).toBe(false);
  });
});

describe("importSceneFile", () => {
  const calls: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: any;
  }[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const headers = Object.fromEntries(
          Object.entries((init.headers as Record<string, string>) || {}),
        );
        calls.push({
          method: init.method || "GET",
          url,
          headers,
          body: init.body,
        });
        if (url === "/api/scenes" && init.method === "POST") {
          const requested = JSON.parse(init.body as string);
          return new Response(
            JSON.stringify({
              scene: {
                id: "abcdef0123456789abcd",
                name: requested.name,
                collectionId: requested.collectionId,
                shareMode: "private",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                deletedAt: null,
                hasThumbnail: false,
              },
              permission: "owner",
              roomKey: ROOM_KEY,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith("/api/rooms/") && init.method === "PUT") {
          return new Response(JSON.stringify({ rev: 1 }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.startsWith("/api/files/") && init.method === "PUT") {
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the scene, stores the encrypted room and uploads files", async () => {
    const rect = API.createElement({ type: "rectangle", id: "r1", x: 0, y: 0 });
    const image = API.createElement({
      type: "image",
      id: "i1",
      fileId: "file-1" as any,
      status: "saved",
    });
    const file = new File(
      [
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          elements: [rect, image],
          appState: {},
          files: {
            "file-1": {
              id: "file-1",
              mimeType: "image/png",
              dataURL: "data:image/png;base64,iVBORw0KGgo=",
              created: 1,
            },
          },
        }),
      ],
      "My diagram.excalidraw",
      { type: "application/json" },
    );

    const scene = await importSceneFile(file, "col-1");
    expect(scene.name).toBe("My diagram");
    expect(scene.collectionId).toBe("col-1");

    const create = calls.find((c) => c.url === "/api/scenes");
    expect(JSON.parse(create!.body)).toEqual({
      name: "My diagram",
      collectionId: "col-1",
    });

    const room = calls.find((c) => c.url.startsWith("/api/rooms/"));
    expect(room!.url).toBe("/api/rooms/abcdef0123456789abcd");
    expect(room!.headers["If-None-Match"]).toBe("*");
    const payload = JSON.parse(room!.body);

    const decrypted = await decryptData(
      base64ToBytes(payload.iv) as Uint8Array<ArrayBuffer>,
      base64ToBytes(payload.ciphertext),
      ROOM_KEY,
    );
    const elements = JSON.parse(new TextDecoder().decode(decrypted));
    expect(elements.map((e: any) => e.id)).toEqual(["r1", "i1"]);
    // restore() may bump versions; the stored sceneVersion must match what
    // was actually encrypted (upstream getSceneVersion semantics).
    expect(payload.sceneVersion).toBe(
      elements.reduce((acc: number, e: any) => acc + e.version, 0),
    );

    const upload = calls.find((c) => c.url.startsWith("/api/files/"));
    expect(upload!.url).toBe("/api/files/rooms/abcdef0123456789abcd/file-1");
    expect(upload!.body).toBeInstanceOf(Uint8Array);
  });

  it("rejects files that are not scenes", async () => {
    const file = new File(["not json"], "x.excalidraw");
    await expect(importSceneFile(file, null)).rejects.toThrow();
    expect(calls.find((c) => c.url === "/api/scenes")).toBeUndefined();
  });
});
