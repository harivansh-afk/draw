import { useEffect, useState } from "react";

import { ExcalidrawLogo } from "@excalidraw/excalidraw/components/ExcalidrawLogo";

import { api } from "../data/api";

import { loginIcon } from "./icons";
import { Button, TextInput, errorMessage } from "./ui";

import type { AuthConfig } from "../data/api";

const ERRORS: Record<string, string> = {
  not_allowed: "This account is not allowed here.",
  oidc: "Sign-in with the identity provider failed. Try again.",
};

export const Login = ({
  next,
  error,
}: {
  next: string;
  error: string | null;
}) => {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    api.auth
      .config()
      .then(setConfig)
      .catch(() => setConfig({ devLogin: false, provider: "Google" }));
  }, []);

  const devLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) {
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await api.auth.devLogin(email.trim());
      window.location.assign(next);
    } catch (err) {
      setLocalError(errorMessage(err, "Could not sign in"));
      setBusy(false);
    }
  };

  const message =
    localError || (error ? ERRORS[error] || "Sign-in failed." : null);

  return (
    <div className="dash-login">
      <div className="dash-login__card">
        <ExcalidrawLogo size="normal" withText />
        <p className="dash-login__lede">
          Your whiteboards, saved and shared from your own server.
        </p>
        {message && (
          <div className="dash-login__error" role="alert">
            {message}
          </div>
        )}
        <Button
          variant="primary"
          size="large"
          icon={loginIcon}
          className="dash-login__provider"
          onClick={() => window.location.assign(api.auth.oidcStartUrl(next))}
        >
          Sign in with {config?.provider || "Google"}
        </Button>
        {config?.devLogin && (
          <form className="dash-login__dev" onSubmit={devLogin}>
            <div className="dash-login__divider">
              <span>development</span>
            </div>
            <TextInput
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              data-autofocus
            />
            <Button
              type="submit"
              size="large"
              busy={busy}
              disabled={!email.trim()}
            >
              Sign in (dev)
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};
