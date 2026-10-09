#!/usr/bin/env node
// Paseo dashboard server: polls a Paseo daemon (or the demo fleet), keeps the
// latest snapshot and pushes it to browsers over Server-Sent Events.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize as normPath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalize } from "./lib/normalize.mjs";
import { createPaseoSource } from "./lib/source-paseo.mjs";
import { createDemoSource } from "./lib/source-demo.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");

const { values: args } = parseArgs({
  options: {
    demo: { type: "boolean", default: process.env.PASEO_DASHBOARD_DEMO === "1" },
    frozen: { type: "boolean", default: process.env.PASEO_DASHBOARD_FROZEN === "1" },
    url: { type: "string", default: process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws" },
    password: { type: "string", default: process.env.PASEO_PASSWORD },
    port: { type: "string", default: process.env.PORT ?? "4317" },
    host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
    interval: { type: "string", default: process.env.PASEO_DASHBOARD_INTERVAL ?? "4000" },
  },
});

const pollMs = Math.max(1000, Number(args.interval) || 4000);
const source = args.demo
  ? createDemoSource({
      frozen: args.frozen,
      now: process.env.PASEO_DASHBOARD_NOW ? Date.parse(process.env.PASEO_DASHBOARD_NOW) : undefined,
    })
  : createPaseoSource({ url: args.url, password: args.password });
const now = () => (source.now ? source.now() : Date.now());

let snapshot = {
  source: { kind: source.kind, label: source.label },
  connection: { status: "connecting", error: null, lastSuccessAt: null },
  pollMs,
  fetchedAt: null,
  now: new Date(now()).toISOString(),
  data: { workspaces: [], tasks: [], todos: [] },
};
const clients = new Set();

function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of clients) res.write(payload);
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const raw = await source.fetch();
    const t = now();
    snapshot = {
      ...snapshot,
      connection: { status: "ok", error: null, lastSuccessAt: new Date(t).toISOString() },
      fetchedAt: new Date(t).toISOString(),
      now: new Date(t).toISOString(),
      data: normalize(raw, t),
    };
  } catch (error) {
    snapshot = {
      ...snapshot,
      connection: { ...snapshot.connection, status: "error", error: String(error?.message ?? error) },
      now: new Date(now()).toISOString(),
    };
    console.warn(`[dashboard] ${snapshot.connection.error}`);
  } finally {
    polling = false;
    broadcast();
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(snapshot));
    return;
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    await poll();
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  // Static files, confined to ./public.
  let path = url.pathname === "/" || url.pathname === "/metriques" ? "/index.html" : url.pathname;
  path = normPath(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
});

server.listen(Number(args.port), args.host, () => {
  const addr = server.address();
  console.log(
    `Paseo dashboard → http://${args.host}:${addr.port}  (source: ${source.kind === "demo" ? source.label : args.url}, rafraîchi toutes les ${pollMs / 1000}s)`,
  );
});

await poll();
const timer = setInterval(poll, pollMs);

async function shutdown() {
  clearInterval(timer);
  for (const res of clients) res.end();
  server.close();
  await source.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
