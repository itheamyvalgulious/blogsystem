/**
 * Tests for the loopback PDF document host.
 *
 * These run in plain Node (no Electron): the host itself only uses
 * `node:http` and `fetch`.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { startPdfDocumentHost, type RunningPdfDocumentHost } from "./pdf-document-host";

const DOCUMENT_HTML = "<!DOCTYPE html><html><body><img src=\"/asset.png\"></body></html>";
const ASSET_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);

interface UpstreamRequest {
  cookie: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

describe("startPdfDocumentHost", () => {
  let upstream: Server;
  let upstreamOrigin: string;
  let upstreamRequests: UpstreamRequest[];
  let host: RunningPdfDocumentHost;

  before(async () => {
    upstreamRequests = [];
    upstream = createServer((request, response) => {
      upstreamRequests.push({
        cookie: request.headers.cookie,
        method: request.method,
        url: request.url
      });

      if (request.url === "/asset.png") {
        const requiresSession = !(request.headers.cookie ?? "").includes("sid=test-session");

        if (requiresSession) {
          response.writeHead(401, { "Content-Type": "text/plain" });
          response.end("unauthorized");
          return;
        }

        response.writeHead(200, {
          "Content-Type": "image/png",
          "Set-Cookie": "leaked=1; Path=/"
        });
        response.end(ASSET_BYTES);
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    upstreamOrigin = `http://127.0.0.1:${address.port}`;

    host = await startPdfDocumentHost({ html: DOCUMENT_HTML, assetOrigin: upstreamOrigin });
  });

  after(async () => {
    await host.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("serves the document on an ephemeral loopback port with an unguessable path", async () => {
    const url = new URL(host.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.pathname, /^\/__pdf_document__\/[0-9a-f]{32}$/);

    const response = await fetch(host.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), DOCUMENT_HTML);
  });

  it("returns 404 for the root path instead of leaking the document", async () => {
    const rootUrl = new URL(host.url);
    rootUrl.pathname = "/";
    const response = await fetch(rootUrl);
    assert.equal(response.status, 404);
  });

  it("proxies asset requests to the admin origin, forwarding the session cookie", async () => {
    const assetUrl = new URL("/asset.png", host.url);
    const response = await fetch(assetUrl, {
      headers: { cookie: "sid=test-session" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    // Admin cookies must never be re-issued for the temporary document origin.
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), ASSET_BYTES);

    const proxied = upstreamRequests.find(
      (request) => request.url === "/asset.png" && request.cookie === "sid=test-session"
    );
    assert.ok(proxied, "upstream must receive the forwarded cookie");
  });

  it("preserves upstream auth failures instead of injecting credentials", async () => {
    const assetUrl = new URL("/asset.png", host.url);
    const response = await fetch(assetUrl);
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "unauthorized");
  });

  it("rejects protocol-relative request targets so the proxy cannot escape the admin origin", async () => {
    // fetch() normalizes `//host/path` to an absolute URL, so drive the raw
    // request through node:http to reproduce a malicious request-target.
    const { request } = await import("node:http");
    const url = new URL(host.url);

    const status = await new Promise<number>((resolve, reject) => {
      const raw = request(
        {
          hostname: url.hostname,
          method: "GET",
          path: "//evil.example/steal",
          port: url.port
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      raw.on("error", reject);
      raw.end();
    });

    assert.equal(status, 400);
  });
});
