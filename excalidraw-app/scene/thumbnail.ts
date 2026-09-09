import { exportToCanvas } from "@excalidraw/excalidraw";
import { THEME } from "@excalidraw/common";
import { getNonDeletedElements } from "@excalidraw/element";
import throttle from "lodash.throttle";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { THUMBNAIL_INTERVAL_MS } from "../app_constants";
import { api } from "../data/api";

import { canEditScene, getScene } from "./sceneMode";

export const THUMBNAIL_WIDTH = 640;
export const THUMBNAIL_HEIGHT = 400;

const renderThumbnail = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<Blob | null> => {
  const appState = excalidrawAPI.getAppState();
  const elements = getNonDeletedElements(excalidrawAPI.getSceneElements());
  const background =
    appState.viewBackgroundColor ||
    (appState.theme === THEME.DARK ? "#121212" : "#ffffff");

  const target = document.createElement("canvas");
  target.width = THUMBNAIL_WIDTH;
  target.height = THUMBNAIL_HEIGHT;
  const ctx = target.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  if (elements.length) {
    const source = await exportToCanvas({
      elements,
      appState: {
        ...appState,
        exportBackground: true,
        viewBackgroundColor: background,
        exportWithDarkMode: appState.theme === THEME.DARK,
        exportScale: 1,
      },
      files: excalidrawAPI.getFiles(),
      maxWidthOrHeight: THUMBNAIL_WIDTH * 2,
      exportPadding: 16,
    });
    const scale = Math.min(
      THUMBNAIL_WIDTH / source.width,
      THUMBNAIL_HEIGHT / source.height,
      1,
    );
    const width = source.width * scale;
    const height = source.height * scale;
    ctx.drawImage(
      source,
      (THUMBNAIL_WIDTH - width) / 2,
      (THUMBNAIL_HEIGHT - height) / 2,
      width,
      height,
    );
  }

  return new Promise((resolve) => target.toBlob(resolve, "image/png"));
};

const upload = async (excalidrawAPI: ExcalidrawImperativeAPI) => {
  const scene = getScene();
  if (!scene || !canEditScene()) {
    return;
  }
  try {
    const blob = await renderThumbnail(excalidrawAPI);
    if (blob) {
      await api.scenes.putThumbnail(scene.scene.id, blob);
    }
  } catch (error: any) {
    console.warn("thumbnail upload failed", error);
  }
};

/** Renders and uploads the scene thumbnail at most once per interval. */
export const queueThumbnailUpload = throttle(upload, THUMBNAIL_INTERVAL_MS, {
  leading: true,
  trailing: true,
});
