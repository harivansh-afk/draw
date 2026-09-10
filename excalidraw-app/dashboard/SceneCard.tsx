import clsx from "clsx";
import React, { useEffect, useRef, useState } from "react";

import { api } from "../data/api";

import { editorPath } from "./router";
import { relativeTime } from "./state";
import {
  DotsHorizontalIcon,
  DuplicateIcon,
  folderMoveIcon,
  LinkIcon,
  pencilIcon,
  restoreIcon,
  shareIcon,
  TrashIcon,
  trashSceneIcon,
} from "./icons";
import { IconButton, Menu, useMenu } from "./ui";

import type { SceneMeta } from "../data/api";
import type { MenuItem } from "./ui";

export type SceneActions = {
  rename: (scene: SceneMeta, name: string) => Promise<void>;
  duplicate: (scene: SceneMeta) => Promise<void>;
  move: (scene: SceneMeta) => void;
  share: (scene: SceneMeta) => void;
  trash: (scene: SceneMeta) => Promise<void>;
  restore: (scene: SceneMeta) => Promise<void>;
  deletePermanently: (scene: SceneMeta) => void;
};

export const SceneCard = ({
  scene,
  inTrash,
  actions,
  now,
  thumbVersion,
  renaming,
  cursor,
  onRenameStart,
  onRenameEnd,
}: {
  scene: SceneMeta;
  inTrash: boolean;
  actions: SceneActions;
  now: number;
  /** cache buster for a thumbnail generated after the list was loaded */
  thumbVersion?: string;
  renaming: boolean;
  /** keyboard cursor: the card the vim motions act on */
  cursor?: boolean;
  onRenameStart: () => void;
  onRenameEnd: () => void;
}) => {
  const menu = useMenu();
  const cardRef = useRef<HTMLElement>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const href = editorPath(scene.id);

  useEffect(() => {
    setThumbFailed(false);
  }, [scene.updatedAt, scene.hasThumbnail, thumbVersion]);

  const items: MenuItem[] = inTrash
    ? [
        {
          label: "Restore",
          icon: restoreIcon,
          onSelect: () => actions.restore(scene),
        },
        { kind: "separator" },
        {
          label: "Delete permanently",
          icon: TrashIcon,
          danger: true,
          onSelect: () => actions.deletePermanently(scene),
        },
      ]
    : [
        { label: "Rename", icon: pencilIcon, onSelect: onRenameStart },
        {
          label: "Share",
          icon: shareIcon,
          onSelect: () => actions.share(scene),
        },
        {
          label: "Duplicate",
          icon: DuplicateIcon,
          onSelect: () => actions.duplicate(scene),
        },
        {
          label: "Move",
          icon: folderMoveIcon,
          onSelect: () => actions.move(scene),
        },
        { kind: "separator" },
        {
          label: "Move to trash",
          icon: TrashIcon,
          danger: true,
          onSelect: () => actions.trash(scene),
        },
      ];

  const showThumb = scene.hasThumbnail && !thumbFailed && !inTrash;
  const shared = scene.shareMode !== "private";

  return (
    <article
      ref={cardRef}
      data-scene-id={scene.id}
      className={clsx("dash-card", {
        "dash-card--menu-open": menu.isOpen,
        "dash-card--trashed": inTrash,
        "dash-card--cursor": cursor,
      })}
      onContextMenu={(event) => {
        event.preventDefault();
        menu.open(cardRef.current!);
      }}
    >
      <a
        className="dash-card__link"
        href={href}
        aria-label={`Open ${scene.name}`}
        draggable={false}
        onClick={(event) => {
          if (inTrash || renaming) {
            event.preventDefault();
          }
        }}
      >
        <div className="dash-card__thumb">
          {showThumb ? (
            <img
              src={api.scenes.thumbnailUrl(
                scene.id,
                thumbVersion ?? scene.updatedAt,
              )}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <div className="dash-card__placeholder" aria-hidden>
              {inTrash ? trashSceneIcon : null}
            </div>
          )}
        </div>
        <div className="dash-card__meta">
          {renaming ? (
            <RenameInput
              initial={scene.name}
              onCommit={async (name) => {
                onRenameEnd();
                if (name && name !== scene.name) {
                  await actions.rename(scene, name);
                }
              }}
              onCancel={onRenameEnd}
            />
          ) : (
            <h3
              className="dash-card__name"
              title={scene.name}
              onDoubleClick={(event) => {
                if (!inTrash) {
                  event.preventDefault();
                  onRenameStart();
                }
              }}
            >
              {scene.name}
            </h3>
          )}
          <div className="dash-card__row">
            <span className="dash-card__time">
              {inTrash && scene.deletedAt
                ? `Deleted ${relativeTime(scene.deletedAt, now)}`
                : relativeTime(scene.updatedAt, now)}
            </span>
            {shared && !inTrash && (
              <span
                className="dash-card__shared"
                title={
                  scene.shareMode === "edit"
                    ? "Anyone with the link can edit"
                    : "Anyone with the link can view"
                }
              >
                {LinkIcon}
              </span>
            )}
          </div>
        </div>
      </a>
      <IconButton
        label={`Options for ${scene.name}`}
        className="dash-card__more"
        onClick={menu.open}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
      >
        {DotsHorizontalIcon}
      </IconButton>
      {menu.isOpen && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          items={items}
          minWidth={170}
          align={menu.anchor === cardRef.current ? "start" : "end"}
        />
      )}
    </article>
  );
};

const RenameInput = ({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) {
      return;
    }
    done.current = true;
    onCommit(value.trim());
  };

  return (
    <input
      ref={ref}
      className="dash-card__rename"
      value={value}
      aria-label="Scene name"
      onClick={(event) => event.preventDefault()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
    />
  );
};

export const SceneCardSkeleton = () => (
  <div className="dash-card dash-card--skeleton" aria-hidden>
    <div className="dash-card__thumb" />
    <div className="dash-card__meta">
      <div className="dash-skeleton dash-skeleton--title" />
      <div className="dash-skeleton dash-skeleton--sub" />
    </div>
  </div>
);
