import clsx from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../app-jotai";
import { api } from "../data/api";
import { avatarInitial, currentUserAtom } from "../data/auth";
import {
  DASHBOARD_URL,
  SCENE_SIDEBAR_MIN_WIDTH,
  sceneAtom,
  sceneSidebarOpenAtom,
} from "../scene/sceneMode";

import "./SceneSidebar.scss";

import type { Collection, SceneMeta } from "../data/api";

const REFRESH_INTERVAL_MS = 60 * 1000;

const chevronLeftIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M15 6l-6 6l6 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const plusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 5l0 14" strokeLinecap="round" />
    <path d="M5 12l14 0" strokeLinecap="round" />
  </svg>
);

const dashboardIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path
      d="M4 4h6v8h-6z M4 16h6v4h-6z M14 12h6v8h-6z M14 4h6v4h-6z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const relativeTime = (iso: string, now = Date.now()): string => {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
};

const Avatar = ({ name, url }: { name: string; url: string }) => {
  return url ? (
    <img
      className="scene-sidebar__avatar"
      src={url}
      alt=""
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="scene-sidebar__avatar scene-sidebar__avatar--initial">
      {avatarInitial(name)}
    </span>
  );
};

/**
 * Plus-style scenes panel shown left of the editor for the scene owner. Lists
 * the scenes of the current collection; each row is a real link so the editor
 * remounts cleanly on navigation.
 */
export const SceneSidebar = () => {
  const open = useAtomValue(sceneSidebarOpenAtom);
  const scene = useAtomValue(sceneAtom);
  const user = useAtomValue(currentUserAtom);
  const [scenes, setScenes] = useState<SceneMeta[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [wide, setWide] = useState(
    () => window.innerWidth >= SCENE_SIDEBAR_MIN_WIDTH,
  );

  const collectionId = scene?.scene.collectionId ?? null;
  const currentId = scene?.scene.id;

  const refresh = useCallback(async () => {
    if (!scene || scene.permission !== "owner") {
      return;
    }
    try {
      const [list, cols] = await Promise.all([
        api.scenes.list({
          collection: collectionId ?? "all",
          sort: "updated",
          order: "desc",
        }),
        api.collections.list(),
      ]);
      setScenes(list.scenes);
      setCollections(cols.collections);
      setNow(Date.now());
    } catch (error: any) {
      console.warn("scene sidebar refresh failed", error);
    }
  }, [scene, collectionId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    refresh();
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    const onFocus = () => {
      if (!document.hidden) {
        refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [open, refresh]);

  useEffect(() => {
    const onResize = () =>
      setWide(window.innerWidth >= SCENE_SIDEBAR_MIN_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // keep the current scene's row in sync with inline renames
  const rows = useMemo(() => {
    if (!scenes) {
      return null;
    }
    if (!scene) {
      return scenes;
    }
    return scenes.map((row) =>
      row.id === scene.scene.id ? { ...row, name: scene.scene.name } : row,
    );
  }, [scenes, scene]);

  if (!scene || scene.permission !== "owner" || !open || !wide) {
    return null;
  }

  const collection = collections.find((c) => c.id === collectionId) || null;
  const ownerName = user?.name || user?.email || "";

  const createScene = async () => {
    try {
      const created = await api.scenes.create({
        name: "Untitled",
        collectionId,
      });
      window.location.assign(`/s/${created.scene.id}`);
    } catch (error: any) {
      console.error(error);
    }
  };

  return (
    <aside className="scene-sidebar" aria-label="Scenes">
      <div className="scene-sidebar__workspace">
        <Avatar name={ownerName} url={user?.avatarUrl || ""} />
        <span className="scene-sidebar__workspace-name">Personal</span>
      </div>

      <a className="scene-sidebar__nav" href={DASHBOARD_URL}>
        <span className="scene-sidebar__nav-icon">{dashboardIcon}</span>
        Dashboard
      </a>

      <div className="scene-sidebar__section">
        <a
          className="scene-sidebar__back"
          href={DASHBOARD_URL}
          title="Back to dashboard"
          aria-label="Back to dashboard"
        >
          {chevronLeftIcon}
        </a>
        <span className="scene-sidebar__section-title">
          {collection ? collection.name : "Scenes"}
        </span>
        <button
          type="button"
          className="scene-sidebar__new"
          title="New scene"
          aria-label="New scene"
          onClick={createScene}
        >
          {plusIcon}
        </button>
      </div>

      <div className="scene-sidebar__list">
        {rows === null ? (
          <div className="scene-sidebar__empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="scene-sidebar__empty">No scenes yet</div>
        ) : (
          rows.map((row) => (
            <a
              key={row.id}
              href={`/s/${row.id}`}
              className={clsx("scene-sidebar__item", {
                active: row.id === currentId,
              })}
              aria-current={row.id === currentId ? "page" : undefined}
            >
              <span className="scene-sidebar__thumb">
                {row.hasThumbnail && (
                  <img
                    src={api.scenes.thumbnailUrl(row.id, row.updatedAt)}
                    alt=""
                    loading="lazy"
                  />
                )}
              </span>
              <span className="scene-sidebar__item-text">
                <span className="scene-sidebar__item-name">
                  {row.name || "Untitled"}
                </span>
                <span className="scene-sidebar__item-meta">by {ownerName}</span>
                <span className="scene-sidebar__item-meta">
                  {relativeTime(row.updatedAt, now)}
                </span>
              </span>
            </a>
          ))
        )}
      </div>

      <div className="scene-sidebar__footer">
        <Avatar name={ownerName} url={user?.avatarUrl || ""} />
        <span className="scene-sidebar__footer-name">{ownerName}</span>
      </div>
    </aside>
  );
};
