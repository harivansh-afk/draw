import { appJotaiStore, atom } from "../app-jotai";

import { api } from "./api";

import type { User } from "./api";

export const currentUserAtom = atom<User | null>(null);

let pending: Promise<User | null> | null = null;

/** Resolves the signed-in user once per page load; any failure reads as signed out. */
export const loadCurrentUser = (): Promise<User | null> => {
  if (!pending) {
    pending = api.auth
      .me()
      .catch(() => null)
      .then((user) => {
        appJotaiStore.set(currentUserAtom, user);
        return user;
      });
  }
  return pending;
};

export const getCurrentUser = () => appJotaiStore.get(currentUserAtom);

export const signOut = async () => {
  try {
    await api.auth.logout();
  } finally {
    window.location.assign("/login");
  }
};

/** Single uppercase initial for avatar fallbacks; falls back to the email. */
export const avatarInitial = (name: string, email = ""): string =>
  (name.trim() || email.trim() || "?").charAt(0).toUpperCase();

export const loginUrl = (next: string = window.location.pathname) =>
  `/login?next=${encodeURIComponent(next)}`;
