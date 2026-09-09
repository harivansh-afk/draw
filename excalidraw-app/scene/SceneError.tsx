import { ExcalidrawLogo } from "@excalidraw/excalidraw/components/ExcalidrawLogo";

import { DASHBOARD_URL } from "./sceneMode";

import "./SceneError.scss";

import type { SceneLoadError } from "./sceneMode";

const COPY: Record<SceneLoadError, { title: string; body: string }> = {
  forbidden: {
    title: "This scene is private",
    body: "Ask the owner to share it with a link, or sign in with an account that has access.",
  },
  not_found: {
    title: "This scene does not exist",
    body: "It may have been deleted, or the link is wrong.",
  },
  error: {
    title: "Couldn't load this scene",
    body: "The server did not respond. Try again in a moment.",
  },
};

export const SceneError = ({ error }: { error: SceneLoadError }) => {
  const copy = COPY[error];
  return (
    <div className="scene-error">
      <div className="scene-error__card">
        <ExcalidrawLogo style={{ width: "2.5rem", height: "2.5rem" }} />
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <div className="scene-error__actions">
          <a className="scene-error__button" href={DASHBOARD_URL}>
            Go to dashboard
          </a>
          {error === "error" && (
            <button
              type="button"
              className="scene-error__button scene-error__button--outline"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
