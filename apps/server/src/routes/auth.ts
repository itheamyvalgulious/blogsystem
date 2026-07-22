import { Router } from "express";

export interface AuthRouterDeps {
  adminPassword: string;
  adminUsername: string;
}

export function createAuthRouter(deps: AuthRouterDeps) {
  const router = Router();

  router.post("/api/auth/login", async (req, res, next) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (username !== deps.adminUsername || password !== deps.adminPassword) {
      // Fixed delay on failure to slow down brute-force attempts; the success
      // path below stays immediate.
      await new Promise((resolve) => setTimeout(resolve, 400));
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }

    // Rotate the session id on privilege change to prevent session fixation:
    // the pre-login (unauthenticated) session id must not remain valid after
    // login, so regenerate first and only then flag the new session.
    req.session.regenerate((error) => {
      if (error) {
        next(error);
        return;
      }

      req.session.isAuthenticated = true;
      res.json({ ok: true, username: deps.adminUsername });
    });
  });

  router.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  return router;
}
