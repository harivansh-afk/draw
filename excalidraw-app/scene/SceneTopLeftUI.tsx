import { KEYS } from "@excalidraw/common";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../app-jotai";

import {
  renameRequestAtom,
  renameScene,
  saveStateAtom,
  sceneAtom,
  sceneSidebarOpenAtom,
  toggleSceneSidebar,
} from "./sceneMode";

import "./SceneTopLeftUI.scss";

const sidebarIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" />
    <path d="M9 4l0 16" />
  </svg>
);

const SAVE_STATE_LABEL = {
  saved: "Saved",
  saving: "Saving…",
  error: "Not saved",
  offline: "Offline",
} as const;

/**
 * Scene-mode additions to the top-left row: a sidebar toggle before the
 * upstream hamburger and the scene name after it (flex `order` places them
 * around the tunnelled main-menu button).
 */
export const SceneTopLeftUI = ({ isMobile }: { isMobile: boolean }) => {
  const scene = useAtomValue(sceneAtom);
  const saveState = useAtomValue(saveStateAtom);
  const sidebarOpen = useAtomValue(sceneSidebarOpenAtom);
  const renameRequest = useAtomValue(renameRequestAtom);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const lastRenameRequest = useRef(renameRequest);

  const canRename = scene?.permission === "owner";
  const name = scene?.scene.name || "Untitled";

  useEffect(() => {
    if (renameRequest !== lastRenameRequest.current) {
      lastRenameRequest.current = renameRequest;
      if (canRename) {
        setDraft(name);
        setEditing(true);
      }
    }
  }, [renameRequest, canRename, name]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!scene) {
    return null;
  }

  const commit = async () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== name) {
      try {
        await renameScene(draft);
      } catch (error: any) {
        console.error(error);
      }
    }
  };

  return (
    <>
      {scene.permission === "owner" && !isMobile && (
        <button
          type="button"
          className={clsx("scene-sidebar-toggle", { active: sidebarOpen })}
          title={sidebarOpen ? "Hide scenes" : "Show scenes"}
          aria-label={sidebarOpen ? "Hide scenes" : "Show scenes"}
          aria-pressed={sidebarOpen}
          onClick={toggleSceneSidebar}
        >
          {sidebarIcon}
        </button>
      )}
      <div className="scene-title">
        {editing ? (
          <input
            ref={inputRef}
            className="scene-title__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === KEYS.ENTER) {
                commit();
              } else if (event.key === KEYS.ESCAPE) {
                setEditing(false);
              }
            }}
            maxLength={200}
          />
        ) : (
          <button
            type="button"
            className={clsx("scene-title__name", {
              "scene-title__name--static": !canRename,
            })}
            title={canRename ? "Rename scene" : name}
            disabled={!canRename}
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            {name}
          </button>
        )}
        {!isMobile && (
          <span
            className={clsx(
              "scene-title__status",
              `scene-title__status--${saveState}`,
            )}
            title={SAVE_STATE_LABEL[saveState]}
          >
            {scene.permission === "view"
              ? "View only"
              : SAVE_STATE_LABEL[saveState]}
          </span>
        )}
      </div>
    </>
  );
};
