// End-to-end: real server (frozen demo fleet) + real browser.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, loadPlaywright, trackErrors, getState } from "./helpers.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
let server;
let browser;
let snap;

before(async () => {
  server = await startServer(["--demo", "--frozen"], { PASEO_DASHBOARD_NOW: "2026-10-09T14:30:00+02:00" });
  snap = await getState(server.url);
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

async function open(path = "/", viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const page = await context.newPage();
  const errors = trackErrors(page);
  await page.goto(server.url + path);
  await page.waitForSelector(path.includes("metriques") ? "[data-testid=kpis]" : "#lanes");
  return { page, errors, context };
}

// Same visibility rule as the UI: active work always, finished work inside the window.
function expectedCounts(span) {
  const now = Date.parse(snap.now);
  const counts = { needs_input: 0, failed: 0, running: 0, review: 0, todo: 0, done: 0 };
  for (const x of snap.data.tasks) {
    if (x.archivedAt || x.state === "done") {
      const end = Date.parse(x.finishedAt ?? x.updatedAt);
      if (end < now - span) continue;
    }
    counts[x.state]++;
  }
  counts.todo += snap.data.todos.length;
  return counts;
}

async function triageCounts(page) {
  return page.$$eval("[data-testid^=count-]", (els) =>
    Object.fromEntries(els.map((e) => [e.dataset.testid.slice(6), Number(e.textContent)])),
  );
}

test("the API serves a demo snapshot with every state represented", () => {
  assert.equal(snap.connection.status, "ok");
  const states = new Set(snap.data.tasks.map((x) => x.state));
  for (const s of ["needs_input", "failed", "running", "review", "done"]) assert.ok(states.has(s), `missing ${s}`);
  assert.ok(snap.data.todos.length > 0);
});

test("triage counts match the data, per time window", async () => {
  const { page, errors, context } = await open();
  assert.deepEqual(await triageCounts(page), expectedCounts(DAY));
  await page.click("[data-window='7d']");
  assert.deepEqual(await triageCounts(page), expectedCounts(7 * DAY));
  await page.click("[data-window='12h']");
  assert.deepEqual(await triageCounts(page), expectedCounts(12 * HOUR));
  assert.deepEqual(errors, []);
  await context.close();
});

test("every workspace has a lane, grouped by project, with the daemon's status", async () => {
  const { page, context } = await open();
  const lanes = await page.$$eval(".lane", (els) =>
    els.map((e) => ({ id: e.dataset.ws, chip: e.querySelector(".ws-status .chip").dataset.state })),
  );
  const real = snap.data.workspaces.filter((w) => !w.synthetic);
  assert.equal(lanes.length, real.length);
  for (const l of lanes) assert.equal(l.chip, real.find((w) => w.id === l.id).status, l.id);
  const projects = await page.$$eval(".project-head h2", (els) => els.map((e) => e.textContent));
  assert.deepEqual([...projects].sort(), [...new Set(real.map((w) => w.project))].sort());
  // Urgent work comes first: the first lane needs input.
  assert.equal(lanes[0].chip, "needs_input");
  await context.close();
});

test("state filter narrows lanes and rows", async () => {
  const { page, context } = await open();
  await page.click("[data-filter=needs_input]");
  assert.equal(await page.getAttribute("[data-filter=needs_input]", "aria-pressed"), "true");
  const rowStates = await page.$$eval(".task-row", (els) => els.map((e) => e.dataset.state));
  const expected = snap.data.tasks.filter((x) => x.state === "needs_input");
  assert.equal(rowStates.length, expected.length);
  assert.ok(rowStates.every((s) => s === "needs_input"));
  const laneIds = await page.$$eval(".lane", (els) => els.map((e) => e.dataset.ws));
  assert.deepEqual(laneIds.sort(), [...new Set(expected.map((x) => x.workspaceId))].sort());
  await page.click("[data-action=clear-filters]");
  assert.equal(await page.getAttribute("[data-filter=needs_input]", "aria-pressed"), "false");
  await context.close();
});

test("search finds a workspace by name and keeps focus while typing", async () => {
  const { page, context } = await open();
  await page.press("body", "/");
  await page.keyboard.type("terraform");
  assert.equal(await page.evaluate(() => document.activeElement.id), "q");
  const lanes = await page.$$eval(".lane .ws-name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(lanes, ["terraform"]);
  await page.fill("#q", "aucune-tache-ne-correspond");
  assert.ok(await page.isVisible("text=Aucune tâche ne correspond"));
  await context.close();
});

test("task drawer shows what the agent is waiting for, Escape closes it", async () => {
  const { page, context } = await open();
  const task = snap.data.tasks.find((x) => x.state === "needs_input");
  await page.click(`.task-row[data-task="${task.id}"]`);
  const drawer = page.locator(".drawer");
  await drawer.waitFor();
  assert.equal(await drawer.locator("h2").textContent(), task.title);
  assert.match(await drawer.locator(".callout").textContent(), new RegExp(task.pendingSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok((await drawer.textContent()).includes(task.id));
  // A fresh snapshot must not steal focus or close the drawer.
  await page.waitForTimeout(4500);
  assert.equal(await page.locator(".drawer").count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".drawer").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.task), task.id);
  await context.close();
});

test("timeline bars open the same drawer and show a tooltip on hover", async () => {
  const { page, context } = await open();
  const bar = page.locator(".seg-bar[data-state=running]").first();
  await bar.hover();
  const tip = page.locator("#tooltip");
  await tip.waitFor({ state: "visible" });
  assert.match(await tip.textContent(), /En cours/);
  await bar.click();
  await page.locator(".drawer").waitFor();
  assert.ok(await page.isVisible(".drawer .chip[data-state=running]"));
  await context.close();
});

test("lanes collapse and the choice survives a reload", async () => {
  const { page, context } = await open();
  const lane = page.locator(".lane").first();
  const id = await lane.getAttribute("data-ws");
  assert.equal(await lane.getAttribute("data-open"), "true");
  await lane.locator(".lane-meta").click();
  assert.equal(await page.getAttribute(`.lane[data-ws="${id}"]`, "data-open"), "false");
  assert.equal(await page.isVisible(`.lane[data-ws="${id}"] .lane-body`), false);
  await page.reload();
  await page.waitForSelector("#lanes");
  assert.equal(await page.getAttribute(`.lane[data-ws="${id}"]`, "data-open"), "false");
  await context.close();
});

test("column view has one column per state with matching counts", async () => {
  const { page, context } = await open();
  await page.click("[data-view=columns]");
  const cols = await page.$$eval(".col", (els) =>
    Object.fromEntries(els.map((e) => [e.dataset.state, e.querySelectorAll(".card").length])),
  );
  assert.deepEqual(cols, expectedCounts(DAY));
  await context.close();
});

test("metrics page: KPIs agree with the raw data and charts are inspectable", async () => {
  const { page, errors, context } = await open("/#/metriques");
  const now = Date.parse(snap.now);
  const finished7 = snap.data.tasks.filter(
    (x) => ["done", "failed", "review"].includes(x.state) && x.finishedAt && Date.parse(x.finishedAt) >= now - 7 * DAY,
  );
  assert.equal(Number(await page.textContent("[data-testid=kpi-finished]")), finished7.length);
  const waiting = snap.data.tasks.filter((x) => x.state === "needs_input" || x.state === "review").length;
  assert.equal(Number(await page.textContent("[data-testid=kpi-waiting]")), waiting);
  const ok = finished7.filter((x) => x.outcome !== "failed").length;
  const success = (await page.textContent("[data-testid=kpi-success]")).replace(/[\u202f\u00a0]/g, " ");
  assert.equal(success, `${Math.round((ok / finished7.length) * 100)} %`);

  await page.locator("[data-testid=chart-per-day] .col-group").last().hover();
  await page.locator("#tooltip").waitFor({ state: "visible" });
  assert.match(await page.textContent("#tooltip"), /Réussies/);

  await page.click("[data-testid=chart-per-day] summary");
  assert.equal(await page.locator("[data-testid=chart-per-day] tbody tr").count(), 14);
  const tableTotal = await page.$$eval("[data-testid=chart-per-day] tbody tr", (rows) =>
    rows.reduce((a, r) => a + Number(r.cells[1].textContent) + Number(r.cells[2].textContent), 0),
  );
  assert.ok(tableTotal >= finished7.length, "14-day table covers the 7-day KPI");
  assert.equal(await page.locator("[data-testid=waiting] li").count(), Math.min(8, waiting));
  assert.deepEqual(errors, []);
  await context.close();
});

test("dark theme toggle switches the palette", async () => {
  const { page, context } = await open();
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click("#theme");
  assert.equal(await page.getAttribute("html", "data-theme"), "dark");
  const afterBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(before, afterBg);
  await context.close();
});

test("keyboard: triage filters toggle with Enter", async () => {
  const { page, context } = await open();
  await page.focus("[data-filter=running]");
  await page.keyboard.press("Enter");
  assert.equal(await page.getAttribute("[data-filter=running]", "aria-pressed"), "true");
  await context.close();
});

test("phone width: no horizontal scrolling on either page", async () => {
  for (const path of ["/", "/#/metriques"]) {
    const { page, errors, context } = await open(path, { width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${path} overflows by ${overflow}px`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
