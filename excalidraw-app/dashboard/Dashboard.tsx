import clsx from "clsx";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api } from "../data/api";

import { ConfirmDialog, MoveDialog, ShareDialog } from "./dialogs";
import { ActionTiles, Header } from "./Header";
import { importSceneFile, isExcalidrawFile } from "./importScene";
import {
  collectionIcon,
  layoutGridIcon,
  pencilIcon,
  TrashIcon,
  uploadIcon,
} from "./icons";
import { editorPath, navigate } from "./router";
import { SceneCard, SceneCardSkeleton } from "./SceneCard";
import { Sidebar } from "./Sidebar";
import { filterScenes, nextUntitledName, sortScenes } from "./state";
import { createBackfill, generateThumbnail } from "./thumbnails";
import { Button, errorMessage, useToast } from "./ui";

import type { Collection, SceneMeta, User } from "../data/api";
import type { DashboardRoute } from "./router";
import type { SceneActions } from "./SceneCard";
import type { Backfill } from "./thumbnails";
import type { SortKey } from "./state";
import type { ThemePreference } from "./theme";

const SORT_STORAGE_KEY = "draw-dashboard-sort";

const readSort = (): SortKey => {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY);
    if (stored === "name" || stored === "created" || stored === "updated") {
      return stored;
    }
  } catch {
    // ignore
  }
  return "updated";
};

type Dialog =
  | { kind: "share"; scene: SceneMeta }
  | { kind: "move"; scene: SceneMeta }
  | { kind: "delete"; scene: SceneMeta }
  | { kind: "emptyTrash" }
  | { kind: "deleteCollection"; collection: Collection }
  | null;

export const Dashboard = ({
  route,
  user,
  themePreference,
  onThemeChange,
  onSignedOut,
}: {
  route: Extract<DashboardRoute, { view: "scenes" | "trash" }>;
  user: User;
  themePreference: ThemePreference;
  onThemeChange: (preference: ThemePreference) => void;
  onSignedOut: () => void;
}) => {
  const toast = useToast();
  const inTrash = route.view === "trash";
  const collectionId = route.view === "scenes" ? route.collectionId : null;

  const [scenes, setScenes] = useState<SceneMeta[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<SortKey>(readSort);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [thumbVersions, setThumbVersions] = useState<Record<string, string>>(
    {},
  );
  const dragDepth = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setRenamingId(null);
  }, [route.view, collectionId]);

  const setSort = (next: SortKey) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  const loadCollections = useCallback(async () => {
    const { collections } = await api.collections.list();
    setCollections(collections);
  }, []);

  const loadScenes = useCallback(async () => {
    const { scenes } = await api.scenes.list({
      collection: inTrash ? "all" : collectionId ?? "all",
      trash: inTrash,
      sort,
    });
    setScenes(scenes);
  }, [inTrash, collectionId, sort]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadScenes(), loadCollections()]);
    } catch (error) {
      toast.push(errorMessage(error, "Could not load scenes"));
    }
  }, [loadScenes, loadCollections, toast]);

  useEffect(() => {
    setScenes(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const visibleScenes = useMemo(
    () => (scenes ? sortScenes(filterScenes(scenes, query), sort) : null),
    [scenes, query, sort],
  );

  const currentCollection = collectionId
    ? collections.find((c) => c.id === collectionId) ?? null
    : null;

  // cards without a thumbnail (imports, scenes saved before thumbnails
  // existed) get one rendered from the persisted room, a couple at a time.
  // The scheduler lives in an effect so StrictMode's mount/unmount/mount
  // cycle cannot leave a stopped instance behind.
  const backfillRef = useRef<Backfill | null>(null);
  useEffect(() => {
    const backfill = createBackfill({
      generate: generateThumbnail,
      onDone: (id, result) => {
        if (result !== "uploaded") {
          return;
        }
        const version = String(Date.now());
        setThumbVersions((current) => ({ ...current, [id]: version }));
        setScenes((current) =>
          current
            ? current.map((scene) =>
                scene.id === id ? { ...scene, hasThumbnail: true } : scene,
              )
            : current,
        );
      },
    });
    backfillRef.current = backfill;
    return () => {
      backfill.stop();
      backfillRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (inTrash || !visibleScenes) {
      return;
    }
    backfillRef.current?.sync(
      visibleScenes
        .filter((scene) => !scene.hasThumbnail)
        .map((scene) => scene.id),
    );
  }, [inTrash, visibleScenes]);

  const searching = query.trim().length > 0;

  const patchScene = (updated: SceneMeta) =>
    setScenes((current) =>
      current
        ? current.map((scene) => (scene.id === updated.id ? updated : scene))
        : current,
    );

  const removeScene = (id: string) =>
    setScenes((current) =>
      current ? current.filter((scene) => scene.id !== id) : current,
    );

  const run = async (
    action: () => Promise<void>,
    failure: string,
    reload = true,
  ) => {
    try {
      await action();
      if (reload) {
        await refresh();
      }
    } catch (error) {
      toast.push(errorMessage(error, failure));
      await refresh();
    }
  };

  const createScene = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const access = await api.scenes.create({
        name: nextUntitledName(scenes ?? []),
        collectionId,
      });
      window.location.assign(editorPath(access.scene.id));
    } catch (error) {
      toast.push(errorMessage(error, "Could not create a scene"));
      setCreating(false);
    }
  };

  const importFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(isExcalidrawFile);
    if (!list.length) {
      toast.push("Drop .excalidraw files to import them");
      return;
    }
    setImporting((count) => count + list.length);
    let imported = 0;
    for (const file of list) {
      try {
        await importSceneFile(file, collectionId);
        imported++;
      } catch (error) {
        toast.push(errorMessage(error, `Could not import ${file.name}`));
      } finally {
        setImporting((count) => count - 1);
      }
    }
    if (imported) {
      toast.push(
        imported === 1 ? "Imported 1 scene" : `Imported ${imported} scenes`,
        "info",
      );
    }
    await refresh();
  };

  const actions: SceneActions = {
    rename: (scene, name) =>
      run(
        async () => {
          patchScene({ ...scene, name });
          patchScene(await api.scenes.update(scene.id, { name }));
        },
        "Could not rename",
        false,
      ),
    duplicate: (scene) =>
      run(async () => {
        await api.scenes.duplicate(scene.id);
      }, "Could not duplicate"),
    move: (scene) => setDialog({ kind: "move", scene }),
    share: (scene) => setDialog({ kind: "share", scene }),
    trash: (scene) =>
      run(async () => {
        removeScene(scene.id);
        await api.scenes.trash(scene.id);
      }, "Could not move to trash"),
    restore: (scene) =>
      run(async () => {
        removeScene(scene.id);
        await api.scenes.restore(scene.id);
      }, "Could not restore"),
    deletePermanently: (scene) => setDialog({ kind: "delete", scene }),
  };

  const onDragEnter = (event: React.DragEvent) => {
    if (inTrash || !Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragging(false);
    }
  };
  const onDrop = (event: React.DragEvent) => {
    if (inTrash) {
      return;
    }
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    importFiles(event.dataTransfer.files);
  };

  const signOut = async () => {
    try {
      await api.auth.logout();
    } finally {
      onSignedOut();
    }
  };

  const headerTitle = inTrash
    ? "Trash"
    : currentCollection
    ? currentCollection.name
    : "Dashboard";
  const headerIcon = inTrash
    ? TrashIcon
    : currentCollection
    ? collectionIcon
    : layoutGridIcon;

  const headerAction = inTrash ? (
    <Button
      variant="danger-outline"
      disabled={!scenes || scenes.length === 0}
      onClick={() => setDialog({ kind: "emptyTrash" })}
    >
      Empty trash permanently
    </Button>
  ) : !currentCollection ? (
    <Button
      variant="primary"
      icon={pencilIcon}
      busy={creating}
      onClick={createScene}
    >
      Start drawing
    </Button>
  ) : null;

  const sectionTitle = searching
    ? `Results for “${query.trim()}”`
    : inTrash
    ? null
    : currentCollection
    ? null
    : "Recently modified by you";

  return (
    <div
      className={clsx("dash-layout", {
        "dash-layout--sidebar-open": sidebarOpen,
      })}
    >
      <div
        className="dash-layout__scrim"
        onClick={() => setSidebarOpen(false)}
        aria-hidden
      />
      <Sidebar
        route={route}
        user={user}
        collections={collections}
        query={query}
        onQueryChange={setQuery}
        themePreference={themePreference}
        onThemeChange={onThemeChange}
        onCreateCollection={(name) =>
          run(async () => {
            const created = await api.collections.create(name);
            navigate({ view: "scenes", collectionId: created.id });
          }, "Could not create the collection")
        }
        onRenameCollection={(id, name) =>
          run(async () => {
            await api.collections.rename(id, name);
          }, "Could not rename the collection")
        }
        onDeleteCollection={async (id) => {
          const collection = collections.find((c) => c.id === id);
          if (collection) {
            setDialog({ kind: "deleteCollection", collection });
          }
        }}
        onSignOut={signOut}
        onNavigate={() => setSidebarOpen(false)}
      />
      <main
        className={clsx("dash-main", { "dash-main--dragging": dragging })}
        onDragEnter={onDragEnter}
        onDragOver={(event) => {
          if (dragging) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <Header
          icon={headerIcon}
          title={headerTitle}
          subtitle={
            inTrash && scenes
              ? `${scenes.length} deleted ${
                  scenes.length === 1 ? "scene" : "scenes"
                } · Restore or remove permanently`
              : undefined
          }
          sort={sort}
          onSortChange={setSort}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          action={headerAction}
        />

        {!inTrash && (
          <ActionTiles
            onImport={importFiles}
            onCreate={createScene}
            creating={creating}
          />
        )}

        {importing > 0 && (
          <div className="dash-notice dash-notice--busy">
            <span className="dash-spinner" />
            Importing {importing} {importing === 1 ? "file" : "files"}…
          </div>
        )}

        {inTrash && (
          <div className="dash-notice">
            Scenes in the trash are deleted after 30 days.
          </div>
        )}

        {sectionTitle && <h2 className="dash-section-title">{sectionTitle}</h2>}

        {visibleScenes === null ? (
          <div className="dash-grid" aria-busy>
            {Array.from({ length: 8 }, (_, i) => (
              <SceneCardSkeleton key={i} />
            ))}
          </div>
        ) : visibleScenes.length === 0 ? (
          <EmptyState
            inTrash={inTrash}
            searching={searching}
            collectionName={currentCollection?.name}
          />
        ) : (
          <div className="dash-grid">
            {visibleScenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                ownerName={user.name || user.email}
                inTrash={inTrash}
                actions={actions}
                now={now}
                thumbVersion={thumbVersions[scene.id]}
                renaming={renamingId === scene.id}
                onRenameStart={() => setRenamingId(scene.id)}
                onRenameEnd={() => setRenamingId(null)}
              />
            ))}
          </div>
        )}

        {dragging && (
          <div className="dash-dropzone" aria-hidden>
            <div className="dash-dropzone__card">
              <span className="dash-dropzone__icon">{uploadIcon}</span>
              Drop .excalidraw files to import them
              {currentCollection ? ` into ${currentCollection.name}` : ""}
            </div>
          </div>
        )}
      </main>

      {dialog?.kind === "share" && (
        <ShareDialog
          scene={dialog.scene}
          onClose={() => setDialog(null)}
          onChange={(scene) => {
            patchScene(scene);
            setDialog({ kind: "share", scene });
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveDialog
          scene={dialog.scene}
          collections={collections}
          onClose={() => setDialog(null)}
          onMove={(target) =>
            run(async () => {
              await api.scenes.update(dialog.scene.id, {
                collectionId: target,
              });
            }, "Could not move the scene")
          }
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete permanently?"
          body={`“${dialog.scene.name}” and its history will be deleted for everyone. This cannot be undone.`}
          confirmLabel="Delete permanently"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(async () => {
              removeScene(dialog.scene.id);
              await api.scenes.deletePermanently(dialog.scene.id);
            }, "Could not delete the scene")
          }
        />
      )}
      {dialog?.kind === "emptyTrash" && (
        <ConfirmDialog
          title="Empty the trash?"
          body={`${scenes?.length ?? 0} ${
            scenes?.length === 1 ? "scene" : "scenes"
          } will be deleted for everyone. This cannot be undone.`}
          confirmLabel="Delete everything"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(async () => {
              const ids = (scenes ?? []).map((scene) => scene.id);
              setScenes([]);
              await Promise.all(
                ids.map((id) => api.scenes.deletePermanently(id)),
              );
            }, "Could not empty the trash")
          }
        />
      )}
      {dialog?.kind === "deleteCollection" && (
        <ConfirmDialog
          title={`Delete “${dialog.collection.name}”?`}
          body="The scenes inside stay in your dashboard; only the collection is removed."
          confirmLabel="Delete collection"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(async () => {
              await api.collections.remove(dialog.collection.id);
              if (collectionId === dialog.collection.id) {
                navigate({ view: "scenes", collectionId: null }, true);
              }
            }, "Could not delete the collection")
          }
        />
      )}
    </div>
  );
};

const EmptyState = ({
  inTrash,
  searching,
  collectionName,
}: {
  inTrash: boolean;
  searching: boolean;
  collectionName?: string;
}) => {
  if (searching) {
    return (
      <div className="dash-empty">
        <p>No scenes match your search.</p>
      </div>
    );
  }
  if (inTrash) {
    return (
      <div className="dash-empty">
        <p>The trash is empty.</p>
      </div>
    );
  }
  return (
    <div className="dash-empty">
      <p>
        {collectionName
          ? `No scenes in ${collectionName} yet.`
          : "No scenes yet. Create one above or drop an .excalidraw file here."}
      </p>
    </div>
  );
};
