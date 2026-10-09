// End-to-end through the Paseo source: server.mjs → lib/source-paseo.mjs →
// SDK-shaped fake (tests/fake-sdk.mjs) → browser. Covers pagination,
// archived agents, schedules, live updates over SSE and daemon outages.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, loadPlaywright, trackErrors, getState, waitFor, ROOT } from "./helpers.mjs";

const MIN = 60000;
const dir = mkdtempSync(join(tmpdir(), "paseo-dash-"));
const STATE = join(dir, "state.json");
const LOG = join(dir, "calls.log");
const iso = (minAgo) => new Date(Date.now() - minAgo * MIN).toISOString();

function agent(id, over) {
  return {
    agent: {
      id,
      provider: "claude",
      cwd: "/srv/shop",
      workspaceId: "ws-main",
      model: "opus",
      createdAt: iso(50),
      updatedAt: iso(5),
      lastUserMessageAt: iso(50),
      status: "idle",
      activeTurn: null,
      capabilities: {},
      currentModeId: "default",
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      lastUsage: { inputTokens: 120000, outputTokens: 9000, totalCostUsd: 1.25 },
      title: id,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
      ...over,
    },
    project: { projectKey: "shop", projectName: "shop", workspaceName: null, checkout: {} },
  };
}

function ws(id, name, dirPath, status) {
  return {
    id,
    projectId: "p-shop",
    projectDisplayName: "shop",
    projectRootPath: "/srv/shop",
    workspaceDirectory: dirPath,
    projectKind: "git",
    workspaceKind: id === "ws-main" ? "local_checkout" : "worktree",
    name,
    title: null,
    status,
    statusEnteredAt: null,
    activityAt: iso(3),
    diffStat: { additions: 12, deletions: 3 },
    scripts: [],
    gitRuntime: { currentBranch: name === "main" ? "main" : `feat/${name}` },
    githubRuntime: null,
  };
}

const baseState = () => ({
  down: false,
  pageSize: 2, // forces several pages per list
  workspaces: [ws("ws-main", "main", "/srv/shop", "running"), ws("ws-pay", "payments", "/srv/shop/.paseo/worktrees/payments", "needs_input")],
  agentEntries: [
    agent("Lancer la migration", { status: "running", activeTurn: { turnId: "t1", startedAt: iso(7) } }),
    agent("Corriger le webhook Stripe", {
      workspaceId: "ws-pay",
      cwd: "/srv/shop/.paseo/worktrees/payments",
      status: "running",
      pendingPermissions: [{ id: "p1", provider: "claude", name: "Bash", kind: "tool", title: "Exécuter stripe listen" }],
      requiresAttention: true,
      attentionReason: "permission",
      attentionTimestamp: iso(2),
    }),
    agent("Écrire les tests de remboursement", { workspaceId: "ws-pay", cwd: "/srv/shop/.paseo/worktrees/payments", status: "error", lastError: "Tests failing: 2", requiresAttention: true, attentionReason: "error", attentionTimestamp: iso(4) }),
    agent("Résumé du diff", { requiresAttention: true, attentionReason: "finished", attentionTimestamp: iso(1) }),
    agent("Ancienne tâche archivée", { archivedAt: iso(30), updatedAt: iso(35), createdAt: iso(90) }),
  ],
  schedules: [
    {
      id: "sched-1",
      name: "Revue nocturne",
      prompt: "Relis les PR ouvertes",
      cadence: { type: "cron", expression: "0 2 * * *" },
      target: { type: "new-agent", config: { provider: "codex", cwd: "/srv/shop/.paseo/worktrees/payments" } },
      status: "active",
      createdAt: iso(1000),
      updatedAt: iso(1000),
      nextRunAt: iso(-120),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
    },
  ],
});

let state = baseState();
function save() {
  writeFileSync(STATE, JSON.stringify(state));
}

let server;
let browser;

before(async () => {
  save();
  writeFileSync(LOG, "");
  server = await startServer(["--url", "ws://devbox.local:6767/ws", "--password", "s3cret", "--interval", "1000"], {
    PASEO_SDK_MODULE: pathToFileURL(join(ROOT, "tests", "fake-sdk.mjs")).href,
    PASEO_FAKE_STATE: STATE,
    PASEO_FAKE_LOG: LOG,
  });
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const calls = () =>
  readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("talks to the daemon the way the SDK expects", async () => {
  await waitFor(async () => (await getState(server.url)).connection.status === "ok");
  const log = calls();
  const ctor = log.find((c) => c.call === "new DaemonClient");
  assert.equal(ctor.url, "ws://devbox.local:6767/ws");
  assert.equal(ctor.clientType, "cli");
  assert.equal(ctor.hasPassword, true);
  const agentCalls = log.filter((c) => c.call === "agents.list");
  assert.ok(agentCalls.every((c) => c.options.filter.includeArchived === true), "archived agents are requested");
  const cursors = agentCalls.map((c) => c.options.page.cursor ?? null);
  assert.ok(cursors.includes("2") && cursors.includes("4"), `pagination followed: ${cursors}`);
  assert.ok(log.some((c) => c.call === "scheduleList"));
});

test("snapshot contains every agent across pages, mapped to the right state", async () => {
  const snap = await getState(server.url);
  assert.equal(snap.source.kind, "paseo");
  const by = Object.fromEntries(snap.data.tasks.map((x) => [x.id, x]));
  assert.equal(snap.data.tasks.length, 5);
  assert.equal(by["Lancer la migration"].state, "running");
  assert.equal(by["Corriger le webhook Stripe"].state, "needs_input");
  assert.equal(by["Corriger le webhook Stripe"].pendingSummary, "Exécuter stripe listen");
  assert.equal(by["Écrire les tests de remboursement"].state, "failed");
  assert.equal(by["Résumé du diff"].state, "review");
  assert.equal(by["Ancienne tâche archivée"].state, "done");
  assert.equal(snap.data.todos[0].workspaceId, "ws-pay");
});

test("browser shows live daemon data and updates without reload", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const page = await context.newPage();
  const errors = trackErrors(page);
  await page.goto(server.url);
  await page.waitForSelector("#lanes");
  assert.match(await page.textContent("#conn"), /En direct · ws:\/\/devbox\.local:6767\/ws/);
  const count = (s) => page.textContent(`[data-testid=count-${s}]`).then(Number);
  assert.equal(await count("needs_input"), 1);
  assert.equal(await count("running"), 1);
  assert.equal(await count("failed"), 1);
  assert.equal(await count("review"), 1);
  assert.equal(await count("todo"), 1);
  assert.equal(await count("done"), 1);
  // payments needs input → listed before main
  const lanes = await page.$$eval(".lane .ws-name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(lanes, ["payments", "main"]);
  assert.match(await page.title(), /^\(1\) Tâches/);

  // The migration finishes in Paseo: the page follows on its own.
  const migration = state.agentEntries[0].agent;
  Object.assign(migration, {
    status: "idle",
    activeTurn: null,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  state.workspaces[0].status = "attention";
  save();
  await page.waitForFunction(() => document.querySelector("[data-testid=count-review]")?.textContent === "2", null, { timeout: 8000 });
  assert.equal(await count("running"), 0);
  assert.equal(await page.getAttribute('.lane[data-ws="ws-main"] .ws-status .chip', "data-state"), "review");
  assert.deepEqual(errors, []);
  await context.close();
});

test("daemon outage: keeps the last data, says so, then recovers", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR" });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForSelector("#lanes");

  state.down = true;
  save();
  await page.waitForSelector("[role=alert]", { timeout: 8000 });
  assert.match(await page.textContent("[role=alert]"), /Le daemon Paseo ne répond pas/);
  assert.equal(await page.getAttribute("#conn", "data-status"), "error");
  assert.ok((await page.locator(".lane").count()) > 0, "last known data stays on screen");

  const before = calls().filter((c) => c.call === "new DaemonClient").length;
  state.down = false;
  save();
  await page.waitForSelector("[role=alert]", { state: "detached", timeout: 8000 });
  assert.equal(await page.getAttribute("#conn", "data-status"), "ok");
  const afterCount = calls().filter((c) => c.call === "new DaemonClient").length;
  assert.ok(afterCount > before, "a fresh client is created after the outage");
  await context.close();
});

test("metrics page works on daemon data", async () => {
  const context = await browser.newContext({ locale: "fr-FR" });
  const page = await context.newPage();
  const errors = trackErrors(page);
  await page.goto(`${server.url}/#/metriques`);
  await page.waitForSelector("[data-testid=kpis]");
  // archived + failed + review(s) finished in the last 7 days
  const snap = await getState(server.url);
  const finished = snap.data.tasks.filter((x) => ["done", "failed", "review"].includes(x.state)).length;
  assert.equal(Number(await page.textContent("[data-testid=kpi-finished]")), finished);
  assert.deepEqual(errors, []);
  await context.close();
});
