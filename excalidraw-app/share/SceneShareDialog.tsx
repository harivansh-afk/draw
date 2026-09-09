import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { RadioGroup } from "@excalidraw/excalidraw/components/RadioGroup";
import { Switch } from "@excalidraw/excalidraw/components/Switch";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  copyIcon,
  LinkIcon,
  tablerCheckIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { KEYS } from "@excalidraw/common";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { useAtom, useAtomValue } from "../app-jotai";
import { getSceneLink, sceneAtom, setSceneShareMode } from "../scene/sceneMode";

import { shareDialogStateAtom } from "./ShareDialog";

import "./ShareDialog.scss";
import "./SceneShareDialog.scss";

import type { ShareMode } from "../data/api";
import type { CollabAPI } from "../collab/Collab";

type GuestPermission = Exclude<ShareMode, "private">;

const GUEST_CHOICES: {
  value: GuestPermission;
  label: string;
  ariaLabel: string;
}[] = [
  { value: "view", label: "View only", ariaLabel: "Guests can only view" },
  { value: "edit", label: "Can edit", ariaLabel: "Guests can edit" },
];

const SceneShareDialogInner = ({
  collabAPI,
  handleClose,
  onExportToBackend,
}: {
  collabAPI: CollabAPI | null;
  handleClose: () => void;
  onExportToBackend: () => void;
}) => {
  const { t } = useI18n();
  const scene = useAtomValue(sceneAtom);
  const ref = useRef<HTMLInputElement>(null);
  const { onCopy, copyStatus } = useCopyStatus();
  const [pendingMode, setPendingMode] = useState<ShareMode | null>(null);
  const [lastGuestPermission, setLastGuestPermission] =
    useState<GuestPermission>("view");
  const [accessError, setAccessError] = useState<string | null>(null);

  if (!scene) {
    return null;
  }

  const link = getSceneLink(scene.scene.id);
  const isOwner = scene.permission === "owner";
  const shareMode = pendingMode ?? scene.scene.shareMode;
  const publicLinkOn = shareMode !== "private";
  const guestPermission: GuestPermission = publicLinkOn
    ? (shareMode as GuestPermission)
    : lastGuestPermission;

  const copyLink = async () => {
    try {
      await copyTextToSystemClipboard(link);
    } catch (e) {
      collabAPI?.setCollabError(t("errors.copyToSystemClipboardFailed"));
    }
    ref.current?.select();
    onCopy();
  };

  const changeAccess = async (mode: ShareMode) => {
    setPendingMode(mode);
    setAccessError(null);
    if (mode !== "private") {
      setLastGuestPermission(mode);
    }
    try {
      await setSceneShareMode(mode);
    } catch (error: any) {
      setAccessError("Couldn't update access. Try again.");
    } finally {
      setPendingMode(null);
    }
  };

  return (
    <div className="SceneShareDialog">
      <div className="SceneShareDialog__tabs">
        <span className="SceneShareDialog__tab active">Share scene</span>
      </div>

      <div className="SceneShareDialog__body">
        {collabAPI && (
          <TextField
            defaultValue={collabAPI.getUsername()}
            placeholder="Your name"
            label="Your name"
            onChange={collabAPI.setUsername}
            onKeyDown={(event) => event.key === KEYS.ENTER && handleClose()}
          />
        )}

        {isOwner ? (
          <>
            <div className="SceneShareDialog__row SceneShareDialog__public">
              <div>
                <div className="SceneShareDialog__public-title">
                  Public link
                  <span
                    className={clsx("SceneShareDialog__pill", {
                      on: publicLinkOn,
                    })}
                  >
                    {publicLinkOn ? "On" : "Off"}
                  </span>
                </div>
                <div className="SceneShareDialog__hint">
                  {publicLinkOn
                    ? "Share one link with the access below."
                    : "Only you can open this scene."}
                </div>
              </div>
              <Switch
                name="scene-public-link"
                title="Public link"
                checked={publicLinkOn}
                onChange={(checked) =>
                  changeAccess(checked ? lastGuestPermission : "private")
                }
              />
            </div>
            {accessError && (
              <div className="SceneShareDialog__error">{accessError}</div>
            )}
          </>
        ) : (
          <div className="SceneShareDialog__hint">
            {scene.permission === "edit"
              ? "Anyone with this link can edit the scene."
              : "Anyone with this link can view the scene."}
          </div>
        )}

        <div
          className={clsx("SceneShareDialog__link", {
            disabled: isOwner && !publicLinkOn,
          })}
        >
          <div className="SceneShareDialog__label">Share link</div>
          <div className="SceneShareDialog__link-row">
            <TextField ref={ref} readonly fullWidth value={link} />
            <button
              type="button"
              className="SceneShareDialog__copy"
              title={t("buttons.copyLink")}
              aria-label={t("buttons.copyLink")}
              onClick={copyLink}
            >
              {copyStatus === "success" ? tablerCheckIcon : copyIcon}
            </button>
          </div>
        </div>

        {isOwner && (
          <div className="SceneShareDialog__guests">
            <div className="SceneShareDialog__heading">Guest permissions</div>
            <div
              className={clsx("SceneShareDialog__row", {
                disabled: !publicLinkOn,
              })}
            >
              <span>Canvas</span>
              <RadioGroup
                name="scene-guest-permission"
                value={guestPermission}
                onChange={(value) => changeAccess(value)}
                choices={GUEST_CHOICES}
              />
            </div>
          </div>
        )}

        <div className="ShareDialog__separator">
          <span>{t("shareDialog.or")}</span>
        </div>

        <div className="ShareDialog__picker__header">
          {t("exportDialog.link_title")}
        </div>
        <div className="ShareDialog__picker__description">
          {t("exportDialog.link_details")}
        </div>
        <div className="ShareDialog__picker__button">
          <FilledButton
            size="large"
            label={t("exportDialog.link_button")}
            icon={LinkIcon}
            onClick={async () => {
              await onExportToBackend();
              handleClose();
            }}
          />
        </div>
      </div>
    </div>
  );
};

/** Share dialog for scene mode: public link + guest permissions instead of start/stop session. */
export const SceneShareDialog = (props: {
  collabAPI: CollabAPI | null;
  onExportToBackend: () => void;
}) => {
  const [shareDialogState, setShareDialogState] = useAtom(shareDialogStateAtom);
  const { openDialog } = useUIAppState();

  useEffect(() => {
    if (openDialog) {
      setShareDialogState({ isOpen: false });
    }
  }, [openDialog, setShareDialogState]);

  if (!shareDialogState.isOpen) {
    return null;
  }

  const handleClose = () => setShareDialogState({ isOpen: false });

  return (
    <Dialog size="small" onCloseRequest={handleClose} title={false}>
      <div className="ShareDialog">
        <SceneShareDialogInner
          collabAPI={props.collabAPI}
          handleClose={handleClose}
          onExportToBackend={props.onExportToBackend}
        />
      </div>
    </Dialog>
  );
};
