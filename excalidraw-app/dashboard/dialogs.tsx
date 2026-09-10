import clsx from "clsx";
import React, { useEffect, useRef, useState } from "react";

import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";

import { api } from "../data/api";

import { editorPath } from "./router";
import {
  checkIcon,
  copyIcon,
  folderIcon,
  LockedIcon,
  usersIcon,
  worldIcon,
} from "./icons";
import { Button, Modal, TextInput, errorMessage, useToast } from "./ui";

import type { Collection, SceneMeta, ShareMode } from "../data/api";

const SHARE_OPTIONS: {
  value: ShareMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "private",
    label: "private",
    description: "only you can open this scene.",
    icon: LockedIcon,
  },
  {
    value: "view",
    label: "anyone with the link can view",
    description: "viewers see live changes but cannot edit.",
    icon: worldIcon,
  },
  {
    value: "edit",
    label: "anyone with the link can edit",
    description: "anyone with the link collaborates in real time.",
    icon: usersIcon,
  },
];

export const ShareDialog = ({
  scene,
  onClose,
  onChange,
}: {
  scene: SceneMeta;
  onClose: () => void;
  onChange: (scene: SceneMeta) => void;
}) => {
  const toast = useToast();
  const [mode, setMode] = useState<ShareMode>(scene.shareMode);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number>(0);
  const link = `${window.location.origin}${editorPath(scene.id)}`;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const update = async (next: ShareMode) => {
    if (next === mode || saving) {
      return;
    }
    const previous = mode;
    setMode(next);
    setSaving(true);
    try {
      onChange(await api.scenes.update(scene.id, { shareMode: next }));
    } catch (error) {
      setMode(previous);
      toast.push(errorMessage(error, "Could not change access"));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await copyTextToSystemClipboard(link);
      setCopied(true);
      inputRef.current?.select();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push("Could not copy to the clipboard");
    }
  };

  return (
    <Modal title="share" onClose={onClose}>
      <div className="dash-share">
        <div className="dash-share__scene">{scene.name}</div>
        <div className="dash-share__link">
          <TextInput
            ref={inputRef}
            label="link"
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="primary"
            size="large"
            icon={copied ? checkIcon : copyIcon}
            onClick={copy}
          >
            {copied ? "copied" : "copy link"}
          </Button>
        </div>
        <div
          className="dash-share__access"
          role="radiogroup"
          aria-label="Access"
        >
          <div className="dash-field__label">access</div>
          {SHARE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              className={clsx("dash-share__option", {
                "dash-share__option--active": mode === option.value,
              })}
              disabled={saving}
              onClick={() => update(option.value)}
            >
              <span className="dash-share__option-icon">{option.icon}</span>
              <span className="dash-share__option-text">
                <span className="dash-share__option-label">{option.label}</span>
                <span className="dash-share__option-desc">
                  {option.description}
                </span>
              </span>
              <span className="dash-share__option-check">
                {mode === option.value && checkIcon}
              </span>
            </button>
          ))}
        </div>
        <p className="dash-share__note">
          {mode === "private"
            ? "the link only works for you while the scene is private."
            : "anyone who has the link can open it without signing in. switch back to private to revoke."}
        </p>
      </div>
    </Modal>
  );
};

export const MoveDialog = ({
  scene,
  collections,
  onClose,
  onMove,
}: {
  scene: SceneMeta;
  collections: Collection[];
  onClose: () => void;
  onMove: (collectionId: string | null) => Promise<void>;
}) => {
  const [busy, setBusy] = useState<string | null>(null);
  const choose = async (collectionId: string | null) => {
    setBusy(collectionId ?? "none");
    try {
      await onMove(collectionId);
      onClose();
    } finally {
      setBusy(null);
    }
  };
  const options: { id: string | null; name: string }[] = [
    { id: null, name: "no collection" },
    ...collections.map((c) => ({ id: c.id, name: c.name })),
  ];
  return (
    <Modal title={`move “${scene.name}”`} onClose={onClose}>
      <div className="dash-move">
        {options.map((option) => {
          const current = (scene.collectionId ?? null) === option.id;
          return (
            <button
              key={option.id ?? "none"}
              type="button"
              className={clsx("dash-move__option", {
                "dash-move__option--current": current,
              })}
              disabled={current || busy !== null}
              onClick={() => choose(option.id)}
            >
              <span className="dash-move__icon">{folderIcon}</span>
              <span className="dash-move__name">{option.name}</span>
              {current && <span className="dash-move__current">current</span>}
            </button>
          );
        })}
        {collections.length === 0 && (
          <p className="dash-share__note">
            create a collection from the sidebar to organise scenes.
          </p>
        )}
      </div>
    </Modal>
  );
};

export const ConfirmDialog = ({
  title,
  body,
  confirmLabel,
  danger,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button size="large" onClick={onClose} disabled={busy}>
            cancel
          </Button>
          <Button
            size="large"
            variant={danger ? "danger" : "primary"}
            busy={busy}
            data-autofocus
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dash-confirm__body">{body}</p>
    </Modal>
  );
};
