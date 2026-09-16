import { useState } from "react";

declare global {
  interface Window {
    /** Exposed by the Electron preload script (apps/desktop/src/preload.ts). */
    desktopAuth?: {
      getCredentials(): { username: string; password: string } | null;
    };
  }
}

export function LoginView({
  busy,
  error,
  onLogin
}: {
  busy: boolean;
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  // Prefill from the desktop shell when available; otherwise start empty.
  const [prefill] = useState(() => {
    try {
      return typeof window === "undefined" ? null : window.desktopAuth?.getCredentials() ?? null;
    } catch {
      return null;
    }
  });
  const [username, setUsername] = useState(prefill?.username ?? "");
  const [password, setPassword] = useState(prefill?.password ?? "");

  return (
    <div className="login-shell">
      <div className="login-card">
        <div>
          <p className="title-overline">Knowledge Base Admin</p>
          <h1>Admin Workbench</h1>
        </div>
        <form
          className="login-form"
          onSubmit={async (event) => {
            event.preventDefault();
            await onLogin(username, password);
          }}
        >
          <label>
            <span>Username</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            <span>Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button className="action-button primary" disabled={busy} type="submit">
            {busy ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
