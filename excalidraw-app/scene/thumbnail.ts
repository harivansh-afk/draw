import { exportToCanvas } from "@excalidraw/excalidraw";
import { THEME } from "@excalidraw/common";
import { getNonDeletedElements } from "@excalidraw/element";
import throttle from "lodash.throttle";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { THUMBNAIL_INTERVAL_MS } from "../app_constants";
import { api } from "../data/api";

import { canEditScene, getScene } from "./sceneMode";

export const THUMBNAIL_WIDTH = 640;
export const THUMBNAIL_HEIGHT = 400;

export type ThumbnailSource = {
  elements: readonly ExcalidrawElement[];
  appState?: Partial<AppState> | null;
  files?: BinaryFiles | null;
};

/** Store light pixels so each viewer can apply their theme exactly once. */
export const thumbnailExportState = (appState?: Partial<AppState> | null) => {
  const background = appState?.viewBackgroundColor || "#ffffff";
  return {
    background,
    appState: {
      ...(appState || {}),
      theme: THEME.LIGHT,
      exportBackground: true,
      viewBackgroundColor: background,
      exportWithDarkMode: false,
      exportScale: 1,
    } as Partial<AppState>,
  };
};

/** Where a rendered scene of the given size lands inside the thumbnail. */
export const fitThumbnail = (width: number, height: number) => {
  const scale = Math.min(THUMBNAIL_WIDTH / width, THUMBNAIL_HEIGHT / height, 1);
  const w = width * scale;
  const h = height * scale;
  return {
    x: (THUMBNAIL_WIDTH - w) / 2,
    y: (THUMBNAIL_HEIGHT - h) / 2,
    width: w,
    height: h,
  };
};

/**
 * Renders a 640×400 PNG of a scene. Used by the editor after saves, by the
 * dashboard when a card has no thumbnail yet, and by the file import.
 */
export const renderSceneThumbnail = async ({
  elements,
  appState,
  files,
}: ThumbnailSource): Promise<Blob | null> => {
  const visible = getNonDeletedElements(elements);
  const { background, appState: exportState } = thumbnailExportState(appState);

  const target = document.createElement("canvas");
  target.width = THUMBNAIL_WIDTH;
  target.height = THUMBNAIL_HEIGHT;
  const ctx = target.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  if (visible.length) {
    const source = await exportToCanvas({
      elements: visible,
      appState: exportState,
      files: files || {},
      maxWidthOrHeight: THUMBNAIL_WIDTH * 2,
      exportPadding: 16,
    });
    const box = fitThumbnail(source.width, source.height);
    ctx.drawImage(source, box.x, box.y, box.width, box.height);
  }

  return new Promise((resolve) => target.toBlob(resolve, "image/png"));
};

const renderThumbnail = (excalidrawAPI: ExcalidrawImperativeAPI) =>
  renderSceneThumbnail({
    elements: excalidrawAPI.getSceneElements(),
    appState: excalidrawAPI.getAppState(),
    files: excalidrawAPI.getFiles(),
  });

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
