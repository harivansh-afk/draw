/**
 * Scene mode (`/s/:id`): the editor is bound to a saved scene whose room is
 * the scene id. This module holds the route parsing and the shared state the
 * collab layer, menus and dialogs read.
 */
import { appJotaiStore, atom } from "../app-jotai";
import { api, isApiError } from "../data/api";
import { loginUrl } from "../data/auth";

import type { SceneAccess } from "../data/api";

export type AppMode = "scene" | "local" | "dashboard";

const SCENE_PATH_RE = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/;

export const getSceneIdFromPath = (
  pathname: string = window.location.pathname,
): string | null => {
  const match = pathname.match(SCENE_PATH_RE);
  return match ? match[1] : null;
};

export const getAppMode = (
  pathname: string = window.location.pathname,
): AppMode => {
  if (getSceneIdFromPath(pathname)) {
    return "scene";
  }
  if (pathname === "/local" || pathname === "/local/") {
    return "local";
  }
  return "dashboard";
};

export const isSceneMode = () => getSceneIdFromPath() !== null;

export const sceneAtom = atom<SceneAccess | null>(null);

export type SceneLoadError = "forbidden" | "not_found" | "error";
export const sceneErrorAtom = atom<SceneLoadError | null>(null);

export type SaveState = "saved" | "saving" | "error" | "offline";
export const saveStateAtom = atom<SaveState>("saved");

export const getScene = () => appJotaiStore.get(sceneAtom);

export const isSceneReadOnly = () => getScene()?.permission === "view";

export const canEditScene = () => {
  const scene = getScene();
  return !!scene && scene.permission !== "view";
};

export const isSceneOwner = () => getScene()?.permission === "owner";

export const setSaveState = (state: SaveState) => {
  if (appJotaiStore.get(saveStateAtom) !== state) {
    appJotaiStore.set(saveStateAtom, state);
  }
};

/**
 * Loads scene access for the current `/s/:id` route. Redirects to the login
 * page when anonymous and the scene is not shared; records other failures in
 * `sceneErrorAtom` and resolves to `null`.
 */
export const loadScene = async (id: string): Promise<SceneAccess | null> => {
  try {
    const access = await api.scenes.get(id);
    appJotaiStore.set(sceneAtom, access);
    appJotaiStore.set(sceneErrorAtom, null);
    return access;
  } catch (error) {
    if (isApiError(error, 401)) {
      window.location.replace(loginUrl());
      return null;
    }
    appJotaiStore.set(
      sceneErrorAtom,
      isApiError(error, 403)
        ? "forbidden"
        : isApiError(error, 404)
        ? "not_found"
        : "error",
    );
    return null;
  }
};

export const renameScene = async (name: string) => {
  const scene = getScene();
  if (!scene) {
    return;
  }
  const trimmed = name.trim() || "Untitled";
  const updated = await api.scenes.update(scene.scene.id, { name: trimmed });
  appJotaiStore.set(sceneAtom, { ...scene, scene: updated });
};

export const setSceneShareMode = async (
  shareMode: SceneAccess["scene"]["shareMode"],
) => {
  const scene = getScene();
  if (!scene) {
    return;
  }
  const updated = await api.scenes.update(scene.scene.id, { shareMode });
  appJotaiStore.set(sceneAtom, { ...scene, scene: updated });
};

export const getSceneLink = (id: string) => `${window.location.origin}/s/${id}`;

export const DASHBOARD_URL = "/";

/** Bumped by the main menu's "Rename scene"; the name label enters edit mode. */
export const renameRequestAtom = atom(0);

export const requestRename = () => {
  appJotaiStore.set(renameRequestAtom, Date.now());
};

const SIDEBAR_STORAGE_KEY = "draw-scene-sidebar";
export const SCENE_SIDEBAR_MIN_WIDTH = 800;

const readSidebarPreference = (): boolean => {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "open") {
      return true;
    }
    if (stored === "closed") {
      return false;
    }
  } catch {
    // no storage
  }
  return window.innerWidth >= SCENE_SIDEBAR_MIN_WIDTH;
};

export const sceneSidebarOpenAtom = atom<boolean>(readSidebarPreference());

export const setSceneSidebarOpen = (open: boolean) => {
  appJotaiStore.set(sceneSidebarOpenAtom, open);
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // no storage
  }
};

export const toggleSceneSidebar = () => {
  setSceneSidebarOpen(!appJotaiStore.get(sceneSidebarOpenAtom));
};
