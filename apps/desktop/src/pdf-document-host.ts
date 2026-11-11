/**
 * Loopback HTTP host for the Electron PDF print document.
 *
 * ## Why this exists
 *
 * The print document used to be written to a temp file and loaded through
 * `file://`. Chromium treats `file://` documents as cross-site, which silently
 * broke two classes of resources:
 *
 * - **Authenticated images** (`/media/...`, `/content-files/...`): the
 *   `SameSite=Lax` session cookie is withheld from subresource requests made
 *   by a `file://` document, so the server answered 401 and images rendered
 *   blank in the PDF.
 * - **Webfonts** (KaTeX and theme fonts): font requests from a `file://`
 *   document carry `Origin: null`, so the admin origin's responses were
 *   rejected by CORS and text fell back to system fonts.
 *
 * Serving the document from `http://127.0.0.1:<ephemeral port>` and
 * reverse-proxying every other request to the admin origin makes all assets
 * same-origin with the document: cookies attach normally (cookies are
 * host-scoped, not port-scoped) and no CORS is involved.
 *
 * The document itself is served under an unguessable random path so other
 * local processes cannot read the article HTML from the port while the export
 * runs. Proxy requests forward the caller's own headers (including Cookie);
 * the host never injects credentials of its own.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface RunningPdfDocumentHost {
  /** URL the hidden BrowserWindow must load. */
  url: string;
  close(): Promise<void>;
}

export interface StartPdfDocumentHostOptions {
  /** Complete HTML document to serve. */
  html: string;
  /** Admin origin to reverse-proxy asset requests to, e.g. `http://127.0.0.1:8788`. */
  assetOrigin: string;
}

/** Headers that are connection-specific and must not be forwarded either way. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

/**
 * Upstream response headers that must not be copied verbatim. `content-length`
 * and `content-encoding` are recomputed for the buffered body, and `set-cookie`
 * must not leak admin cookies onto the temporary document origin.
 */
const UNFORWARDED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
  "set-cookie"
]);

/** Upper bound for a single proxied asset request. */
const PROXY_TIMEOUT_MS = 30_000;

function writePlainText(response: ServerResponse, statusCode: number, message: string) {
  const body = Buffer.from(message, "utf8");
  response.writeHead(statusCode, {
    "Content-Length": String(body.byteLength),
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(body);
}

function serveDocument(response: ServerResponse, html: string) {
  const body = Buffer.from(html, "utf8");
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(body);
}

async function proxyToAssetOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  assetOrigin: string
): Promise<void> {
  const requestTarget = request.url ?? "/";

  // Reject protocol-relative targets (`//host/path`) so `new URL` cannot
  // escape the configured admin origin.
  if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
    writePlainText(response, 400, "Invalid request target.");
    return;
  }

  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();

    if (
      value === undefined ||
      lowerKey === "host" ||
      lowerKey === "accept-encoding" ||
      HOP_BY_HOP_HEADERS.has(lowerKey)
    ) {
      continue;
    }

    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  let upstream: Response;

  try {
    upstream = await fetch(new URL(requestTarget, assetOrigin), {
      headers,
      method: request.method === "HEAD" ? "HEAD" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writePlainText(response, 504, `PDF asset proxy failed: ${detail}`);
    return;
  }

  response.statusCode = upstream.status;

  for (const [key, value] of upstream.headers.entries()) {
    if (UNFORWARDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    response.setHeader(key, value);
  }

  if (request.method === "HEAD" || upstream.status === 204 || upstream.status === 304) {
    response.removeHeader("content-length");
    response.end();
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

/**
 * Start an ephemeral loopback host that serves `html` and proxies every other
 * GET/HEAD request to `assetOrigin`.
 *
 * The caller must always `close()` it (typically in a `finally` block) after
 * the hidden BrowserWindow has been destroyed.
 */
export async function startPdfDocumentHost(
  options: StartPdfDocumentHostOptions
): Promise<RunningPdfDocumentHost> {
  const documentPath = `/__pdf_document__/${randomBytes(16).toString("hex")}`;
  const assetOrigin = new URL(options.assetOrigin).origin;

  const server = createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0];

    if (request.method === "GET" && pathname === documentPath) {
      serveDocument(response, options.html);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      writePlainText(response, 405, "Method not allowed.");
      return;
    }

    void proxyToAssetOrigin(request, response, assetOrigin).catch(() => {
      if (!response.headersSent) {
        writePlainText(response, 502, "PDF asset proxy error.");
      } else {
        response.destroy();
      }
    });
  });

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
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The PDF document host did not expose a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}${documentPath}`,
    close() {
      return new Promise<void>((resolve) => {
        // Drop keep-alive sockets so close() cannot wait for an idle window.
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  };
}
