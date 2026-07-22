import type express from "express";

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.session.isAuthenticated) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  next();
}
