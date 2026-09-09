import {
  loginIcon,
  eyeIcon,
  save,
  LibraryIcon,
  pencilIcon,
  share,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { useAtomValue } from "../app-jotai";
import { currentUserAtom, signOut } from "../data/auth";
import {
  DASHBOARD_URL,
  isSceneMode,
  requestRename,
  sceneAtom,
} from "../scene/sceneMode";

import { saveDebugState } from "./DebugCanvas";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
  onSaveToDashboard?: () => void;
  onLeaveScene?: () => Promise<void> | void;
  onShareDialogOpen?: () => void;
}> = React.memo((props) => {
  const { t } = useI18n();
  const user = useAtomValue(currentUserAtom);
  const scene = useAtomValue(sceneAtom);
  const sceneMode = isSceneMode();

  const visualDebug = isDevEnv() && (
    <MainMenu.Item
      icon={eyeIcon}
      onSelect={() => {
        if (window.visualDebug) {
          delete window.visualDebug;
          saveDebugState({ enabled: false });
        } else {
          window.visualDebug = { data: [] };
          saveDebugState({ enabled: true });
        }
        props?.refresh();
      }}
    >
      Visual Debug
    </MainMenu.Item>
  );

  const signOutItem = user && (
    <>
      <MainMenu.Separator />
      <MainMenu.Item icon={loginIcon} onSelect={() => signOut()}>
        Sign out
      </MainMenu.Item>
    </>
  );

  const appearance = (
    <>
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </>
  );

  if (sceneMode) {
    // Excalidraw+ ordering: scene actions, share, then editor utilities
    return (
      <MainMenu>
        {scene?.permission === "owner" && (
          <MainMenu.Item icon={pencilIcon} onSelect={() => requestRename()}>
            Rename scene
          </MainMenu.Item>
        )}
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.Item
          icon={share}
          onSelect={() => props.onShareDialogOpen?.()}
        >
          {t("labels.share")}
        </MainMenu.Item>
        <MainMenu.Item
          icon={LibraryIcon}
          onSelect={async () => {
            await props.onLeaveScene?.();
            window.location.assign(DASHBOARD_URL);
          }}
        >
          Dashboard
        </MainMenu.Item>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.CommandPalette className="highlighted" />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        {visualDebug}
        <MainMenu.Separator />
        {appearance}
        {signOutItem}
      </MainMenu>
    );
  }

  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.Item
        icon={save}
        onSelect={() => props.onSaveToDashboard?.()}
        className="highlighted"
      >
        Save to dashboard
      </MainMenu.Item>
      <MainMenu.DefaultItems.Socials />
      {visualDebug}
      <MainMenu.Separator />
      {appearance}
      {signOutItem}
    </MainMenu>
  );
});
