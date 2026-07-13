import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createApp } from "./app.js";
import { getDefaultSettings, type ServerSettings } from "./config.js";

export interface RunningServer {
  close(): Promise<void>;
  server: HttpServer;
  settings: ServerSettings;
}

function isDirectExecution() {
  const entryPath = process.argv[1];

  if (!entryPath) {
    return false;
  }

  return import.meta.url === pathToFileURL(entryPath).href;
}

export async function startServer(customSettings?: Partial<ServerSettings>): Promise<RunningServer> {
  const settings = {
    ...getDefaultSettings(),
    ...customSettings
  };
  const app = createApp(settings);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    // Bind to the configured host (defaults to loopback) so the server is not
    // reachable from the LAN unless explicitly opted in via HOST=0.0.0.0.
    server.listen(settings.port, settings.host);
  });

  return {
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    server,
    settings
  };
}

if (isDirectExecution()) {
  void startServer()
    .then(({ settings }) => {
      console.log(`Blog system API listening on http://${settings.host}:${settings.port}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
