import clsx from "clsx";
import React, { useEffect, useRef, useState } from "react";

import { avatarInitial } from "../data/auth";

import { navigate } from "./router";
import {
  chevronUpDownIcon,
  collectionIcon,
  DeviceDesktopIcon,
  DotsHorizontalIcon,
  layoutGridIcon,
  logoutIcon,
  MoonIcon,
  PlusIcon,
  searchIcon,
  SunIcon,
  TrashIcon,
} from "./icons";
import { IconButton, Menu, useMenu } from "./ui";

import type { Collection, User } from "../data/api";
import type { DashboardRoute } from "./router";
import type { ThemePreference } from "./theme";

const THEME_ITEMS: {
  value: ThemePreference;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: DeviceDesktopIcon },
];

export const Sidebar = ({
  route,
  user,
  collections,
  query,
  onQueryChange,
  themePreference,
  onThemeChange,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onSignOut,
  onNavigate,
  createRequest = 0,
}: {
  route: DashboardRoute;
  user: User;
  collections: Collection[];
  query: string;
  onQueryChange: (query: string) => void;
  themePreference: ThemePreference;
  onThemeChange: (preference: ThemePreference) => void;
  onCreateCollection: (name: string) => Promise<void>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
  onSignOut: () => void;
  onNavigate: () => void;
  /** bumped by the `c` command to start a new collection from the keyboard */
  createRequest?: number;
}) => {
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(query);
  const workspaceMenu = useMenu();
  const themeMenu = useMenu();

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (createRequest > 0) {
      setCreating(true);
    }
  }, [createRequest]);

  useEffect(() => {
    if (draft === query) {
      return;
    }
    const timer = window.setTimeout(() => onQueryChange(draft), 150);
    return () => window.clearTimeout(timer);
  }, [draft, query, onQueryChange]);

  const activeCollection =
    route.view === "scenes" ? route.collectionId : undefined;

  const go = (next: DashboardRoute) => {
    navigate(next);
    onNavigate();
  };

  return (
    <nav className="dash-sidebar" aria-label="Dashboard">
      <button
        type="button"
        className="dash-workspace"
        onClick={workspaceMenu.open}
        aria-haspopup="menu"
        aria-expanded={workspaceMenu.isOpen}
      >
        <Avatar user={user} size={36} />
        <span className="dash-workspace__name">Personal</span>
        <span className="dash-workspace__chevron">{chevronUpDownIcon}</span>
      </button>
      {workspaceMenu.isOpen && (
        <Menu
          anchor={workspaceMenu.anchor}
          onClose={workspaceMenu.close}
          align="start"
          minWidth={220}
          items={[
            { kind: "heading", label: user.email },
            { label: "Sign out", icon: logoutIcon, onSelect: onSignOut },
          ]}
        />
      )}

      <label className="dash-search">
        <span className="dash-search__icon">{searchIcon}</span>
        <input
          type="search"
          placeholder="Search"
          aria-label="Search scenes"
          data-dash-search
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && draft) {
              event.preventDefault();
              setDraft("");
              onQueryChange("");
            }
          }}
        />
      </label>

      <div className="dash-sidebar__nav">
        <NavRow
          icon={layoutGridIcon}
          label="Dashboard"
          active={route.view === "scenes" && !route.collectionId}
          href="/"
          onSelect={() => go({ view: "scenes", collectionId: null })}
        />
        <NavRow
          icon={TrashIcon}
          label="Trash"
          active={route.view === "trash"}
          href="/trash"
          onSelect={() => go({ view: "trash" })}
        />
      </div>

      <div className="dash-sidebar__collections">
        <div className="dash-sidebar__heading">
          <span>Collections</span>
          <button
            type="button"
            className="dash-sidebar__add"
            aria-label="New collection"
            title="New collection"
            onClick={() => setCreating(true)}
          >
            {PlusIcon}
          </button>
        </div>
        <div className="dash-sidebar__list">
          {creating && (
            <InlineName
              placeholder="Collection name"
              onCommit={async (name) => {
                setCreating(false);
                if (name) {
                  await onCreateCollection(name);
                }
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {collections.length === 0 && !creating && (
            <div className="dash-sidebar__empty">No collections yet.</div>
          )}
          {collections.map((collection) =>
            renamingId === collection.id ? (
              <InlineName
                key={collection.id}
                initial={collection.name}
                onCommit={async (name) => {
                  setRenamingId(null);
                  if (name && name !== collection.name) {
                    await onRenameCollection(collection.id, name);
                  }
                }}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <CollectionRow
                key={collection.id}
                collection={collection}
                active={activeCollection === collection.id}
                onSelect={() =>
                  go({ view: "scenes", collectionId: collection.id })
                }
                onRename={() => setRenamingId(collection.id)}
                onDelete={() => onDeleteCollection(collection.id)}
              />
            ),
          )}
        </div>
      </div>

      <div className="dash-sidebar__footer">
        <div className="dash-sidebar__user">
          <Avatar user={user} size={28} />
          <span className="dash-sidebar__user-name" title={user.email}>
            {user.name || user.email}
          </span>
        </div>
        <IconButton
          label="Theme"
          className="dash-sidebar__theme"
          onClick={themeMenu.open}
          aria-haspopup="menu"
          aria-expanded={themeMenu.isOpen}
        >
          {THEME_ITEMS.find((item) => item.value === themePreference)?.icon}
        </IconButton>
        {themeMenu.isOpen && (
          <Menu
            anchor={themeMenu.anchor}
            onClose={themeMenu.close}
            minWidth={160}
            items={[
              { kind: "heading", label: "Theme" },
              ...THEME_ITEMS.map((item) => ({
                label: item.label,
                icon: item.icon,
                selected: item.value === themePreference,
                onSelect: () => onThemeChange(item.value),
              })),
            ]}
          />
        )}
      </div>
    </nav>
  );
};

export const Avatar = ({ user, size = 28 }: { user: User; size?: number }) => {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (user.avatarUrl && !failed) {
    return (
      <img
        className="dash-avatar"
        style={style}
        src={user.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="dash-avatar dash-avatar--initials"
      style={style}
      aria-hidden
    >
      {avatarInitial(user.name, user.email)}
    </span>
  );
};

const NavRow = ({
  icon,
  label,
  active,
  href,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  href: string;
  onSelect: () => void;
}) => (
  <a
    className={clsx("dash-nav-row", { "dash-nav-row--active": active })}
    href={href}
    aria-current={active ? "page" : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      onSelect();
    }}
  >
    <span className="dash-nav-row__icon">{icon}</span>
    <span className="dash-nav-row__label">{label}</span>
  </a>
);

const CollectionRow = ({
  collection,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  collection: Collection;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) => {
  const menu = useMenu();
  return (
    <div
      className={clsx("dash-collection-row", {
        "dash-collection-row--active": active,
        "dash-collection-row--menu-open": menu.isOpen,
      })}
    >
      <a
        className="dash-collection-row__link"
        href={`/?collection=${encodeURIComponent(collection.id)}`}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.button !== 0) {
            return;
          }
          event.preventDefault();
          onSelect();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          onRename();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          menu.open(event.currentTarget.parentElement as HTMLElement);
        }}
      >
        <span className="dash-collection-row__icon">{collectionIcon}</span>
        <span className="dash-collection-row__label">{collection.name}</span>
      </a>
      <IconButton
        label={`Options for ${collection.name}`}
        className="dash-collection-row__more"
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
          minWidth={180}
          items={[
            { label: "Rename", onSelect: onRename },
            { kind: "separator" },
            { label: "Delete collection", danger: true, onSelect: onDelete },
          ]}
        />
      )}
    </div>
  );
};

/** One-line name editor used for creating and renaming collections. */
const InlineName = ({
  initial = "",
  placeholder,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (committed.current) {
      return;
    }
    committed.current = true;
    onCommit(value.trim());
  };

  return (
    <input
      ref={ref}
      className="dash-collection-row dash-collection-row--input"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder || "Name"}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
    />
  );
};
