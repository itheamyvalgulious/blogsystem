import { Router } from "express";

import {
  createProject,
  deleteProject,
  createProjectLog,
  createProjectTask,
  listProjectLogs,
  listProjects,
  listProjectTasks,
  readProject,
  readProjectLog,
  readProjectTask,
  saveProject,
  saveProjectLog,
  saveProjectTask
} from "../project-service.js";

export interface ProjectsRouterDeps {
  projectsRoot: string;
}

export function createProjectsRouter(deps: ProjectsRouterDeps) {
  const router = Router();

  router.get("/api/projects", async (_req, res, next) => {
    try {
      res.json(await listProjects(deps.projectsRoot));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/project/create", async (req, res, next) => {
    try {
      const { goal, targetDate, title } = req.body as {
        goal?: string;
        targetDate?: string;
        title?: string;
      };

      if (!title?.trim()) {
        res.status(400).json({ error: "title is required." });
        return;
      }

      res.json(
        await createProject(deps.projectsRoot, {
          goal,
          targetDate,
          title
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/project", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await readProject(deps.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/project", async (req, res, next) => {
    try {
      const { projectId, raw } = req.body as { projectId?: string; raw?: string };

      if (!projectId || typeof raw !== "string") {
        res.status(400).json({ error: "projectId and raw are required." });
        return;
      }

      res.json(await saveProject(deps.projectsRoot, projectId, raw));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/project/delete", async (req, res, next) => {
    try {
      const { projectId } = req.body as { projectId?: string };

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await deleteProject(deps.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/project/tasks", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await listProjectTasks(deps.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/project/task/create", async (req, res, next) => {
    try {
      const { projectId, title } = req.body as { projectId?: string; title?: string };

      if (!projectId || !title?.trim()) {
        res.status(400).json({ error: "projectId and title are required." });
        return;
      }

      res.json(await createProjectTask(deps.projectsRoot, projectId, title));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/project/task", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");
      const taskId = String(req.query.taskId ?? "");

      if (!projectId || !taskId) {
        res.status(400).json({ error: "projectId and taskId are required." });
        return;
      }

      res.json(await readProjectTask(deps.projectsRoot, projectId, taskId));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/project/task", async (req, res, next) => {
    try {
      const { projectId, raw, taskId } = req.body as {
        projectId?: string;
        raw?: string;
        taskId?: string;
      };

      if (!projectId || !taskId || typeof raw !== "string") {
        res.status(400).json({ error: "projectId, taskId, and raw are required." });
        return;
      }

      res.json(await saveProjectTask(deps.projectsRoot, projectId, taskId, raw));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/project/logs", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await listProjectLogs(deps.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/project/log/create", async (req, res, next) => {
    try {
      const { projectId, taskId, taskIds, type } = req.body as {
        projectId?: string;
        taskId?: string;
        taskIds?: string[];
        type?: string;
      };

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await createProjectLog(deps.projectsRoot, projectId, { taskId, taskIds, type }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/project/log", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");
      const logId = String(req.query.logId ?? "");

      if (!projectId || !logId) {
        res.status(400).json({ error: "projectId and logId are required." });
        return;
      }

      res.json(await readProjectLog(deps.projectsRoot, projectId, logId));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/project/log", async (req, res, next) => {
    try {
      const { logId, projectId, raw } = req.body as {
        logId?: string;
        projectId?: string;
        raw?: string;
      };

      if (!projectId || !logId || typeof raw !== "string") {
        res.status(400).json({ error: "projectId, logId, and raw are required." });
        return;
      }

      res.json(await saveProjectLog(deps.projectsRoot, projectId, logId, raw));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
