import { describe, expect, it } from "vitest";

import { editorPath, parseRoute, routeToPath, sanitizeNext } from "../router";

describe("dashboard router", () => {
  it("parses the scene list and collections", () => {
    expect(parseRoute("/", "")).toEqual({ view: "scenes", collectionId: null });
    expect(parseRoute("", "")).toEqual({ view: "scenes", collectionId: null });
    expect(parseRoute("/", "?collection=abc")).toEqual({
      view: "scenes",
      collectionId: "abc",
    });
  });

  it("parses trash and login", () => {
    expect(parseRoute("/trash", "")).toEqual({ view: "trash" });
    expect(parseRoute("/trash/", "")).toEqual({ view: "trash" });
    expect(parseRoute("/login", "?next=%2Ftrash&error=not_allowed")).toEqual({
      view: "login",
      next: "/trash",
      error: "not_allowed",
    });
  });

  it("never collides with the editor routes", () => {
    for (const route of [
      { view: "scenes", collectionId: null } as const,
      { view: "scenes", collectionId: "x" } as const,
      { view: "trash" } as const,
      { view: "login", next: "/", error: null } as const,
    ]) {
      const path = routeToPath(route);
      expect(path.startsWith("/s/")).toBe(false);
      expect(path.startsWith("/local")).toBe(false);
    }
    expect(editorPath("abc")).toBe("/s/abc");
  });

  it("round-trips routes through paths", () => {
    const routes = [
      { view: "scenes", collectionId: null },
      { view: "scenes", collectionId: "c 1" },
      { view: "trash" },
      { view: "login", next: "/?collection=c1", error: "oidc" },
      { view: "login", next: "/", error: null },
    ] as const;
    for (const route of routes) {
      const path = routeToPath(route);
      const [pathname, search = ""] = path.split("?");
      expect(parseRoute(pathname, search ? `?${search}` : "")).toEqual(route);
    }
  });

  it("only allows same-origin paths as a login target", () => {
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext("/s/abc")).toBe("/s/abc");
    expect(sanitizeNext("https://evil.example")).toBe("/");
    expect(sanitizeNext("//evil.example/x")).toBe("/");
    expect(sanitizeNext("s/abc")).toBe("/");
  });
});
