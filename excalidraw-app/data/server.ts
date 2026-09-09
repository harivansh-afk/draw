/**
 * Room and file persistence against the draw server. Mirrors the interface
 * excalidraw.com's `firebase.ts` offered so the upstream collab flow is
 * unchanged: rooms hold one AES-GCM encrypted element array, reconciled by the
 * client on save under optimistic concurrency (`rev` + If-Match).
 */
import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import {
  decompressData,
  stringToBase64,
  toByteString,
} from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { api, isApiError } from "./api";

import { getSyncableElements } from ".";

import type { RoomPayload } from "./api";
import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "../collab/socket";

const SAVE_RETRIES = 5;

const encodeBase64 = (bytes: Uint8Array | ArrayBuffer) =>
  stringToBase64(toByteString(bytes), true);

// upstream's base64ToArrayBuffer returns Node's pooled buffer under vitest;
// decode by hand so the exact byte length is preserved everywhere
const decodeBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<Omit<RoomPayload, "rev">> => {
  const encoded = new TextEncoder().encode(JSON.stringify(elements));
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return {
    sceneVersion: getSceneVersion(elements),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(encryptedBuffer),
  };
};

const decryptElements = async (
  payload: Omit<RoomPayload, "rev">,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(
    decodeBase64(payload.iv),
    decodeBase64(payload.ciphertext),
    roomKey,
  );
  return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(decrypted)));
};

class ServerSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return ServerSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    ServerSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToServer = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return ServerSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToServer = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        await api.files.put(prefix, id, buffer);
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

/**
 * Saves the room, reconciling against whatever the server holds. Returns the
 * stored elements (which the caller should reconcile back into the scene), or
 * `null` when there is nothing to do.
 */
export const saveToServer = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToServer(portal, elements)
  ) {
    return null;
  }

  let stored: Omit<RoomPayload, "rev"> | null = null;
  let storedElements: SyncableExcalidrawElement[] | null = null;

  for (let attempt = 0; attempt < SAVE_RETRIES; attempt++) {
    const current = await api.rooms.get(roomId);

    if (!current) {
      const payload = await encryptElements(roomKey, elements);
      try {
        await api.rooms.put(roomId, payload, null);
        stored = payload;
        storedElements = [...elements];
        break;
      } catch (error) {
        if (isApiError(error, 412)) {
          continue;
        }
        throw error;
      }
    }

    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(current, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );
    const payload = await encryptElements(roomKey, reconciledElements);
    try {
      await api.rooms.put(roomId, payload, current.rev);
      stored = payload;
      storedElements = reconciledElements;
      break;
    } catch (error) {
      if (isApiError(error, 412)) {
        continue;
      }
      throw error;
    }
  }

  if (!stored || !storedElements) {
    throw new Error("saveToServer: too many concurrent updates");
  }

  ServerSceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

export const loadFromServer = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const payload = await api.rooms.get(roomId);
  if (!payload) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(payload, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    ServerSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromServer = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(api.files.url(prefix, id), {
          credentials: "same-origin",
        });
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

/**
 * Encrypts and stores a full scene into a fresh room. Used by "Save to
 * dashboard" and by the dashboard's file import.
 */
export const createRoomFromScene = async (
  roomId: string,
  roomKey: string,
  elements: readonly ExcalidrawElement[],
) => {
  const payload = await encryptElements(roomKey, elements);
  return api.rooms.put(roomId, payload, null);
};
