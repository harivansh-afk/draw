import { useEffect, useState } from "react";

/**
 * Dashboard routes. Everything lives under `/` so it never collides with the
 * editor's `/s/:id` and `/local`:
 *
 *   /                      all scenes
 *   /?collection=<id>      one collection
 *   /trash                 trashed scenes
 *   /login[?next=&error=]  sign-in screen
 */
export type DashboardRoute =
  | { view: "scenes"; collectionId: string | null }
  | { view: "trash" }
  | { view: "login"; next: string; error: string | null };

export const parseRoute = (
  pathname: string,
  search: string,
): DashboardRoute => {
  const params = new URLSearchParams(search);
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/login") {
    return {
      view: "login",
      next: sanitizeNext(params.get("next")),
      error: params.get("error"),
    };
  }
  if (path === "/trash") {
    return { view: "trash" };
  }
  return { view: "scenes", collectionId: params.get("collection") || null };
};

/** Only same-origin absolute paths are allowed as a post-login target. */
export const sanitizeNext = (next: string | null): string => {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "/";
  }
  return next;
};

export const routeToPath = (route: DashboardRoute): string => {
  switch (route.view) {
    case "trash":
      return "/trash";
    case "login": {
      const params = new URLSearchParams();
      if (route.next && route.next !== "/") {
        params.set("next", route.next);
      }
      if (route.error) {
        params.set("error", route.error);
      }
      const str = params.toString();
      return `/login${str ? `?${str}` : ""}`;
    }
    default:
      return route.collectionId
        ? `/?collection=${encodeURIComponent(route.collectionId)}`
        : "/";
  }
};

export const editorPath = (sceneId: string) => `/s/${sceneId}`;

const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const navigate = (route: DashboardRoute, replace = false) => {
  const path = routeToPath(route);
  if (replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  notify();
};

export const useRoute = (): DashboardRoute => {
  const [route, setRoute] = useState(() =>
    parseRoute(window.location.pathname, window.location.search),
  );
  useEffect(() => {
    const update = () =>
      setRoute(parseRoute(window.location.pathname, window.location.search));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
};
