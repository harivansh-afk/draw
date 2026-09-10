import React, { useRef } from "react";

import { chevronUpDownIcon, HamburgerMenuIcon } from "./icons";
import { SORT_LABELS } from "./state";
import { Button, IconButton, Menu, useMenu } from "./ui";

import type { SortKey } from "./state";

export const Header = ({
  title,
  subtitle,
  sort,
  onSortChange,
  onToggleSidebar,
  actions,
}: {
  title: string;
  subtitle?: string;
  sort?: SortKey;
  onSortChange?: (sort: SortKey) => void;
  onToggleSidebar: () => void;
  actions?: React.ReactNode;
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
        <h1 className="dash-header__title">{title}</h1>
        {subtitle && <div className="dash-header__subtitle">{subtitle}</div>}
      </div>
      <div className="dash-header__actions">
        {sort && onSortChange && (
          <>
            <Button
              variant="ghost"
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
              <span className="dash-header__sort-prefix">sort </span>
              {SORT_LABELS[sort]}
            </Button>
            {sortMenu.isOpen && (
              <Menu
                anchor={sortMenu.anchor}
                onClose={sortMenu.close}
                minWidth={160}
                items={[
                  { kind: "heading", label: "sort by" },
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
        {actions}
      </div>
    </header>
  );
};

/** "import" button backed by a hidden multi-file input. */
export const ImportButton = ({
  onImport,
  hint,
}: {
  onImport: (files: FileList) => void;
  hint?: string;
}) => {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button hint={hint} onClick={() => fileInput.current?.click()}>
        import
      </Button>
      <input
        ref={fileInput}
        data-dash-import
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
    </>
  );
};
