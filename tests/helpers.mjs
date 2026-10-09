import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // Fall back to a globally installed copy (npm i -g playwright).
    const { execSync } = await import("node:child_process");
    const globalRoot = execSync("npm root -g").toString().trim();
    const require = createRequire(join(globalRoot, "noop.js"));
    return require("playwright");
  }
}

/** Starts server.mjs on a free port; resolves once it prints its URL. */
export function startServer(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", "0", ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10000);
    const onData = (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({
          url: `http://127.0.0.1:${m[1]}`,
          output: () => out,
          stop: () =>
            new Promise((r) => {
              child.once("exit", r);
              child.kill("SIGTERM");
            }),
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => (out += d));
    child.once("exit", (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
}

/** Collects page errors, ignoring the web-font request (offline CI). */
export function trackErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/Failed to load resource/.test(text)) return;
    errors.push(text);
  });
  page.on("requestfailed", (r) => {
    if (!r.url().includes("fonts.g")) errors.push(`request failed: ${r.url()}`);
  });
  return errors;
}

export async function getState(url) {
  const r = await fetch(`${url}/api/state`);
  return r.json();
}

export async function waitFor(fn, { timeout = 10000, interval = 100 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw last ?? new Error("waitFor timed out");
}
