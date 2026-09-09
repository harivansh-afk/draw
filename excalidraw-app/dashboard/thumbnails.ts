import { isInitializedImageElement } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { api } from "../data/api";
import { loadFilesFromServer, loadFromServer } from "../data/server";
import { renderSceneThumbnail } from "../scene/thumbnail";

export type BackfillResult = "uploaded" | "empty";

/**
 * Renders and uploads a thumbnail for a scene that has none, from the
 * persisted room. Returns "empty" for rooms without content so the caller can
 * stop retrying a blank scene.
 */
export const generateThumbnail = async (
  sceneId: string,
): Promise<BackfillResult> => {
  const access = await api.scenes.get(sceneId);
  if (access.permission === "view") {
    throw new Error("read-only scene");
  }
  const elements = await loadFromServer(sceneId, access.roomKey, null);
  if (!elements || !elements.some((element) => !element.isDeleted)) {
    return "empty";
  }
  const fileIds = elements
    .filter(isInitializedImageElement)
    .map((element) => element.fileId as FileId);
  const files: BinaryFiles = {};
  if (fileIds.length) {
    const { loadedFiles } = await loadFilesFromServer(
      `rooms/${sceneId}`,
      access.roomKey,
      fileIds,
    );
    for (const file of loadedFiles) {
      files[file.id] = file;
    }
  }
  const blob = await renderSceneThumbnail({ elements, files });
  if (!blob) {
    throw new Error("canvas unavailable");
  }
  await api.scenes.putThumbnail(sceneId, blob);
  return "uploaded";
};

export type Backfill = {
  /** Reconciles the queue with the ids currently on screen, in order. */
  sync: (ids: readonly string[]) => void;
  /** Drops the queue; in-flight work still reports when it finishes. */
  stop: () => void;
};

/**
 * Serialises thumbnail generation for scenes visible on the dashboard: a few
 * at a time, each scene attempted once per session, never for ids that have
 * scrolled away before their turn.
 */
export const createBackfill = ({
  generate,
  onDone,
  concurrency = 2,
}: {
  generate: (id: string) => Promise<BackfillResult>;
  onDone: (id: string, result: BackfillResult | "failed") => void;
  concurrency?: number;
}): Backfill => {
  const attempted = new Set<string>();
  const inFlight = new Set<string>();
  let queue: string[] = [];
  let stopped = false;

  const pump = () => {
    while (!stopped && inFlight.size < concurrency && queue.length) {
      const id = queue.shift()!;
      if (attempted.has(id)) {
        continue;
      }
      attempted.add(id);
      inFlight.add(id);
      generate(id)
        .then((result) => onDone(id, result))
        .catch((error) => {
          console.warn("thumbnail backfill failed", id, error);
          onDone(id, "failed");
        })
        .finally(() => {
          inFlight.delete(id);
          pump();
        });
    }
  };

  return {
    sync: (ids) => {
      queue = ids.filter((id) => !attempted.has(id));
      pump();
    },
    stop: () => {
      stopped = true;
      queue = [];
    },
  };
};
