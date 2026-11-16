import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import ExcalidrawApp from "./App";
import { loadCurrentUser } from "./data/auth";
import { getAppMode } from "./scene/sceneMode";

const DashboardApp = lazy(() =>
  import("./dashboard").then((module) => ({ default: module.DashboardApp })),
);

// the entry's JavaScript and CSS loaded and ran (`scripts/stats/perf.mjs`)
performance.mark("excalidraw:app-start");

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;

const mode = getAppMode();

// excalidraw.com-style links land on the local editor
if (
  mode === "dashboard" &&
  window.location.pathname === "/" &&
  /^#(json|room)=/.test(window.location.hash)
) {
  window.location.replace(`/local${window.location.hash}`);
}

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();

loadCurrentUser().then(() => {
  root.render(
    <StrictMode>
      {mode === "dashboard" ? (
        <Suspense fallback={null}>
          <DashboardApp />
        </Suspense>
      ) : (
        <ExcalidrawApp />
      )}
    </StrictMode>,
  );
});
