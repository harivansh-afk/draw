import React from "react";

import { Card } from "@excalidraw/excalidraw/components/Card";
import { ExcalidrawLogo } from "@excalidraw/excalidraw/components/ExcalidrawLogo";
import { IconButton } from "@excalidraw/excalidraw/components/IconButton";
import { isInitializedImageElement } from "@excalidraw/element";

import type {
  FileId,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { FILE_STORAGE_PREFIXES, FILE_UPLOAD_MAX_BYTES } from "../app_constants";
import { api } from "../data/api";
import { getCurrentUser, loginUrl } from "../data/auth";
import { encodeFilesForUpload } from "../data/FileManager";
import { createRoomFromScene, saveFilesToServer } from "../data/server";

/**
 * Creates a scene from the current canvas and opens it. Signed-out users are
 * sent to the login page and return to `/local` afterwards.
 */
export const saveToDashboard = async (
  elements: readonly NonDeletedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  name: string,
) => {
  if (!getCurrentUser()) {
    window.location.assign(loginUrl("/local"));
    return;
  }

  const access = await api.scenes.create({
    name: name?.trim() || "Untitled",
  });
  const { id } = access.scene;
  const { roomKey } = access;

  await createRoomFromScene(id, roomKey, elements);

  const filesMap = new Map<FileId, BinaryFileData>();
  for (const element of elements) {
    if (isInitializedImageElement(element) && files[element.fileId]) {
      filesMap.set(element.fileId, files[element.fileId]);
    }
  }

  if (filesMap.size) {
    const filesToUpload = await encodeFilesForUpload({
      files: filesMap,
      encryptionKey: roomKey,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });

    await saveFilesToServer({
      prefix: `${FILE_STORAGE_PREFIXES.collabFiles}/${id}`,
      files: filesToUpload,
    });
  }

  window.location.assign(`/s/${id}`);
};

export const SaveToDashboard: React.FC<{
  elements: readonly NonDeletedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  name: string;
  onError: (error: Error) => void;
  onSuccess: () => void;
}> = ({ elements, appState, files, name, onError, onSuccess }) => {
  return (
    <Card color="primary">
      <div className="Card-icon">
        <ExcalidrawLogo
          style={{
            [`--color-logo-icon` as any]: "#fff",
            width: "2.8rem",
            height: "2.8rem",
          }}
        />
      </div>
      <h2>Dashboard</h2>
      <div className="Card-details">
        Save this scene to your dashboard and keep working on it from any
        device.
      </div>
      <IconButton
        className="Card-button"
        type="button"
        title="Save to dashboard"
        aria-label="Save to dashboard"
        showAriaLabel={true}
        onClick={async () => {
          try {
            await saveToDashboard(elements, appState, files, name);
            onSuccess();
          } catch (error: any) {
            console.error(error);
            if (error.name !== "AbortError") {
              onError(new Error("Couldn't save to the dashboard right now."));
            }
          }
        }}
      />
    </Card>
  );
};
