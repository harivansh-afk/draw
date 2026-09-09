import React, { useRef } from "react";

import {
  chevronUpDownIcon,
  filePlusIcon,
  HamburgerMenuIcon,
  importIcon,
  PlusIcon,
} from "./icons";
import { SORT_LABELS } from "./state";
import { Button, IconButton, Menu, useMenu } from "./ui";

import type { SortKey } from "./state";

export const Header = ({
  icon,
  title,
  subtitle,
  sort,
  onSortChange,
  onToggleSidebar,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  sort?: SortKey;
  onSortChange?: (sort: SortKey) => void;
  onToggleSidebar: () => void;
  action?: React.ReactNode;
}) => {
  const sortMenu = useMenu();
  return (
    <header className="dash-header">
      <IconButton
        label="Menu"
        className="dash-header__menu"
        onClick={onToggleSidebar}
      >
        {HamburgerMenuIcon}
      </IconButton>
      <div className="dash-header__titles">
        <div className="dash-header__title-row">
          <span className="dash-header__icon">{icon}</span>
          <h1 className="dash-header__title">{title}</h1>
        </div>
        {subtitle && <div className="dash-header__subtitle">{subtitle}</div>}
      </div>
      <div className="dash-header__actions">
        {sort && onSortChange && (
          <>
            <Button
              className="dash-header__sort"
              onClick={sortMenu.open}
              aria-haspopup="menu"
              aria-expanded={sortMenu.isOpen}
              trailing={
                <span className="dash-button__chevron">
                  {chevronUpDownIcon}
                </span>
              }
            >
              {SORT_LABELS[sort]}
            </Button>
            {sortMenu.isOpen && (
              <Menu
                anchor={sortMenu.anchor}
                onClose={sortMenu.close}
                minWidth={180}
                items={[
                  { kind: "heading", label: "Sort by" },
                  ...(Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({
                    label: SORT_LABELS[key],
                    selected: key === sort,
                    onSelect: () => onSortChange(key),
                  })),
                ]}
              />
            )}
          </>
        )}
        {action}
      </div>
    </header>
  );
};

/** The two wide tiles Excalidraw+ shows above a scene list. */
export const ActionTiles = ({
  onImport,
  onCreate,
  creating,
}: {
  onImport: (files: FileList) => void;
  onCreate: () => void;
  creating: boolean;
}) => {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="dash-tiles">
      <button
        type="button"
        className="dash-tile"
        onClick={() => fileInput.current?.click()}
      >
        <span className="dash-tile__icon">{importIcon}</span>
        <span className="dash-tile__label">Import scenes</span>
        <span className="dash-tile__plus">{PlusIcon}</span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".excalidraw,.json,application/json,application/vnd.excalidraw+json"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) {
            onImport(event.target.files);
          }
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="dash-tile"
        onClick={onCreate}
        disabled={creating}
      >
        <span className="dash-tile__icon">{filePlusIcon}</span>
        <span className="dash-tile__label">Create scene</span>
        <span className="dash-tile__plus">{PlusIcon}</span>
      </button>
    </div>
  );
};
