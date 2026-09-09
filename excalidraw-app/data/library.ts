import type {
  LibraryMigrationAdapter,
  LibraryPersistenceAdapter,
} from "@excalidraw/excalidraw/data/library";
import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";

import { api } from "./api";
import { LibraryIndexedDBAdapter } from "./LocalData";

/** Library persisted per user on the draw server. */
export const LibraryServerAdapter: LibraryPersistenceAdapter = {
  async load() {
    return api.library.get<LibraryPersistedData>();
  },
  async save(data: LibraryPersistedData) {
    await api.library.put(data);
  },
};

/**
 * Uploads a library that lived in this browser's IndexedDB before the user
 * signed in, then clears it so the migration runs once.
 */
export const LibraryIndexedDBMigrationAdapter: LibraryMigrationAdapter = {
  load() {
    return LibraryIndexedDBAdapter.load();
  },
  clear() {
    return LibraryIndexedDBAdapter.clear();
  },
};
