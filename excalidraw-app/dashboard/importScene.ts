import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { encryptData } from "@excalidraw/excalidraw/data/encryption";
import { getSceneVersion } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { FILE_UPLOAD_MAX_BYTES } from "../app_constants";
import { api } from "../data/api";
import { encodeFilesForUpload } from "../data/FileManager";

import { stripExcalidrawExtension } from "./state";

import type { SceneMeta } from "../data/api";

export const bytesToBase64 = (bytes: Uint8Array | ArrayBuffer): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const isExcalidrawFile = (file: File) =>
  /\.excalidraw(\.json)?$/i.test(file.name) ||
  file.type === "application/vnd.excalidraw+json" ||
  file.type === "application/json";

/**
 * Creates a scene from an `.excalidraw` file: parse, create the scene, encrypt
 * the elements with the returned room key, store the room, upload the files.
 * Mirrors what the editor's collab layer does on its first save so the scene
 * opens exactly as if it had been drawn in place.
 */
export const importSceneFile = async (
  file: File,
  collectionId: string | null,
): Promise<SceneMeta> => {
  const data = await loadFromBlob(file, null, null);
  const elements = data.elements;
  const access = await api.scenes.create({
    name: stripExcalidrawExtension(file.name),
    collectionId,
  });
  const { id } = access.scene;
  const { encryptedBuffer, iv } = await encryptData(
    access.roomKey,
    new TextEncoder().encode(JSON.stringify(elements)),
  );
  await api.rooms.put(
    id,
    {
      sceneVersion: getSceneVersion(elements),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(encryptedBuffer),
    },
    null,
  );

  const files = new Map<FileId, BinaryFileData>();
  for (const element of elements) {
    if (
      element.type === "image" &&
      element.fileId &&
      data.files[element.fileId]
    ) {
      files.set(element.fileId, data.files[element.fileId]);
    }
  }
  if (files.size) {
    const encoded = await encodeFilesForUpload({
      files,
      encryptionKey: access.roomKey,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });
    await Promise.all(
      encoded.map(({ id: fileId, buffer }) =>
        api.files.put(`rooms/${id}`, fileId, buffer),
      ),
    );
  }
  return access.scene;
};
