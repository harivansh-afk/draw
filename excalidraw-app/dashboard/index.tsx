import clsx from "clsx";
import React, { useCallback, useEffect, useState } from "react";

import { api } from "../data/api";

import { Dashboard } from "./Dashboard";
import { Login } from "./Login";
import { navigate, useRoute } from "./router";
import { useDashboardTheme } from "./theme";
import { Spinner, ToastProvider } from "./ui";

import "@excalidraw/excalidraw/fonts/fonts.css";
import "./dashboard.scss";

import type { User } from "../data/api";

/**
 * Renders the sign-in screen at `/login` (and at `/` when signed out) and the
 * dashboard otherwise. Navigation to the editor (`/s/:id`) is a full page load.
 */
export const DashboardApp: React.FC = () => {
  const route = useRoute();
  const { preference, theme, setPreference } = useDashboardTheme();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  const loadUser = useCallback(async () => {
    try {
      setUser(await api.auth.me());
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  useEffect(() => {
    if (user && route.view === "login") {
      window.location.replace(route.next);
    }
  }, [user, route]);

  let content: React.ReactNode;
  if (user === undefined) {
    content = (
      <div className="dash-loading">
        <Spinner />
      </div>
    );
  } else if (route.view === "login" || user === null) {
    const next =
      route.view === "login"
        ? route.next
        : `${window.location.pathname}${window.location.search}`;
    content = (
      <Login next={next} error={route.view === "login" ? route.error : null} />
    );
  } else {
    content = (
      <Dashboard
        route={route}
        user={user}
        themePreference={preference}
        onThemeChange={setPreference}
        onSignedOut={() => {
          setUser(null);
          navigate({ view: "login", next: "/", error: null }, true);
        }}
      />
    );
  }

  return (
    <ToastProvider>
      <div
        className={clsx("excalidraw excalidraw-dashboard", {
          "theme--dark": theme === "dark",
        })}
      >
        {content}
      </div>
    </ToastProvider>
  );
};

export default DashboardApp;
