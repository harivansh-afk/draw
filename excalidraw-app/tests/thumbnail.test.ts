import { THEME } from "@excalidraw/common";
import { describe, expect, it } from "vitest";

import {
  fitThumbnail,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  thumbnailExportState,
} from "../scene/thumbnail";

describe("thumbnailExportState", () => {
  it("defaults to a white light-mode export when no app state is given", () => {
    const { background, appState } = thumbnailExportState(null);
    expect(background).toBe("#ffffff");
    expect(appState.exportWithDarkMode).toBe(false);
    expect(appState.exportBackground).toBe(true);
    expect(appState.viewBackgroundColor).toBe("#ffffff");
    expect(appState.exportScale).toBe(1);
  });

  it("keeps the scene background but normalizes dark exports to light", () => {
    const { background, appState } = thumbnailExportState({
      theme: THEME.DARK,
      viewBackgroundColor: "#123456",
      exportWithDarkMode: true,
    });
    expect(background).toBe("#123456");
    expect(appState.exportWithDarkMode).toBe(false);
    expect(appState.theme).toBe(THEME.LIGHT);
  });

  it("uses the same default background regardless of the saving theme", () => {
    expect(thumbnailExportState({ theme: THEME.DARK }).background).toBe(
      "#ffffff",
    );
  });
});

describe("fitThumbnail", () => {
  it("centres a small render without upscaling", () => {
    const box = fitThumbnail(100, 50);
    expect(box).toEqual({
      x: (THUMBNAIL_WIDTH - 100) / 2,
      y: (THUMBNAIL_HEIGHT - 50) / 2,
      width: 100,
      height: 50,
    });
  });

  it("scales a large render down to fit the longer side", () => {
    const box = fitThumbnail(6400, 2000);
    expect(box.width).toBe(THUMBNAIL_WIDTH);
    expect(box.height).toBe(200);
    expect(box.x).toBe(0);
    expect(box.y).toBe((THUMBNAIL_HEIGHT - 200) / 2);
  });
});
