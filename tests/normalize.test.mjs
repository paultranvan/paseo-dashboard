import test from "node:test";
import assert from "node:assert/strict";
import { deriveTaskState, mapWorkspaceStatus, normalize } from "../lib/normalize.mjs";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

function agent(over = {}) {
  return {
    id: "aaaaaaaa-0000-4000-a000-000000000001",
    provider: "claude",
    cwd: "/code/app",
    workspaceId: "ws-1",
    model: "opus",
    createdAt: iso(30),
    updatedAt: iso(10),
    lastUserMessageAt: iso(30),
    status: "idle",
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Tâche",
    labels: {},
    ...over,
  };
}

function workspace(over = {}) {
  return {
    id: "ws-1",
    projectId: "p1",
    projectDisplayName: "app",
    projectRootPath: "/code/app",
    workspaceDirectory: "/code/app",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    activityAt: iso(5),
    scripts: [],
    gitRuntime: { currentBranch: "main" },
    githubRuntime: null,
    ...over,
  };
}

test("task state follows the daemon's precedence", () => {
  // permission beats error beats running beats attention
  assert.equal(deriveTaskState(agent({ status: "error", pendingPermissions: [{ id: "p" }] })), "needs_input");
  assert.equal(deriveTaskState(agent({ status: "running", attentionReason: "permission" })), "needs_input");
  assert.equal(deriveTaskState(agent({ status: "running", attentionReason: "error" })), "failed");
  assert.equal(deriveTaskState(agent({ status: "error" })), "failed");
  assert.equal(deriveTaskState(agent({ status: "running", requiresAttention: true })), "running");
  assert.equal(deriveTaskState(agent({ status: "initializing" })), "running");
  assert.equal(deriveTaskState(agent({ status: "idle", requiresAttention: true, attentionReason: "finished" })), "review");
  assert.equal(deriveTaskState(agent({ status: "idle" })), "done");
  assert.equal(deriveTaskState(agent({ status: "closed" })), "done");
});

test("archived agents are done whatever their last status", () => {
  assert.equal(deriveTaskState(agent({ status: "error", archivedAt: iso(1) })), "done");
  assert.equal(deriveTaskState(agent({ status: "idle", archivedAt: iso(1), pendingPermissions: [{}] })), "done");
});

test("workspace buckets map onto dashboard states", () => {
  assert.deepEqual(
    ["needs_input", "failed", "running", "attention", "done"].map(mapWorkspaceStatus),
    ["needs_input", "failed", "running", "review", "done"],
  );
});

test("outcome separates archived failures from successes", () => {
  const { tasks } = normalize(
    {
      workspaces: [workspace()],
      agentEntries: [
        { agent: agent({ id: "a1", status: "error", archivedAt: iso(2), lastError: "boom" }) },
        { agent: agent({ id: "a2", status: "idle", archivedAt: iso(2) }) },
        { agent: agent({ id: "a3", status: "running", activeTurn: { turnId: "t", startedAt: iso(4) } }) },
      ],
    },
    NOW,
  );
  const by = Object.fromEntries(tasks.map((x) => [x.id, x]));
  assert.equal(by.a1.state, "done");
  assert.equal(by.a1.outcome, "failed");
  assert.equal(by.a2.outcome, "success");
  assert.equal(by.a3.outcome, null);
  assert.equal(by.a3.elapsedMs, 4 * 60000, "running time counts from the current turn");
});

test("agents are placed by workspaceId, then by directory, then in a synthetic workspace", () => {
  const { workspaces, tasks } = normalize(
    {
      workspaces: [workspace(), workspace({ id: "ws-2", name: "feat", workspaceDirectory: "/code/app/.wt/feat" })],
      agentEntries: [
        { agent: agent({ id: "a1", workspaceId: "ws-2" }) },
        { agent: agent({ id: "a2", workspaceId: undefined, cwd: "/code/app/.wt/feat/" }) },
        {
          agent: agent({ id: "a3", workspaceId: "ws-gone", cwd: "/tmp/scratch", status: "error" }),
          project: { projectKey: "k", projectName: "scratch", workspaceName: "tmp", checkout: {} },
        },
      ],
    },
    NOW,
  );
  const by = Object.fromEntries(tasks.map((x) => [x.id, x.workspaceId]));
  assert.equal(by.a1, "ws-2");
  assert.equal(by.a2, "ws-2");
  assert.equal(by.a3, "ws-gone");
  const synthetic = workspaces.find((w) => w.id === "ws-gone");
  assert.equal(synthetic.synthetic, true);
  assert.equal(synthetic.project, "scratch");
  assert.equal(synthetic.status, "failed", "synthetic workspaces derive status from their tasks");
});

test("duplicate and internal agents are dropped", () => {
  const { tasks } = normalize(
    {
      workspaces: [workspace()],
      agentEntries: [{ agent: agent({ id: "a1" }) }, { agent: agent({ id: "a1" }) }, { agent: agent({ id: "a2", internal: true }) }],
    },
    NOW,
  );
  assert.deepEqual(
    tasks.map((x) => x.id),
    ["a1"],
  );
});

test("active schedules become to-do items placed by cwd", () => {
  const { todos, workspaces } = normalize(
    {
      workspaces: [workspace()],
      agentEntries: [],
      schedules: [
        {
          id: "s1",
          name: null,
          prompt: "Audit des dépendances\nen détail",
          cadence: { type: "every", everyMs: 6 * 3600000 },
          target: { type: "new-agent", config: { provider: "codex", cwd: "/code/app/" } },
          status: "active",
          nextRunAt: iso(-30),
          lastRunAt: null,
        },
        { id: "s2", name: "pausée", prompt: "x", cadence: { type: "cron", expression: "0 9 * * *" }, target: { type: "new-agent", config: { provider: "codex", cwd: "/code/app" } }, status: "paused", nextRunAt: iso(-30) },
      ],
    },
    NOW,
  );
  assert.equal(todos.length, 1);
  assert.equal(todos[0].title, "Audit des dépendances");
  assert.equal(todos[0].workspaceId, "ws-1");
  assert.equal(todos[0].cadence, "toutes les 6 h");
  assert.equal(workspaces[0].todoCount, 1);
});

test("pull request checks are summarised", () => {
  const { workspaces } = normalize(
    {
      workspaces: [
        workspace({
          githubRuntime: {
            pullRequest: {
              number: 12,
              url: "https://example.test/pr/12",
              title: "x",
              state: "OPEN",
              baseRefName: "main",
              headRefName: "x",
              isMerged: false,
              checks: [
                { name: "a", status: "failure", url: null },
                { name: "b", status: "pending", url: null },
                { name: "c", status: "success", url: null },
              ],
            },
          },
        }),
      ],
    },
    NOW,
  );
  assert.deepEqual(workspaces[0].pr.checks, { total: 3, failed: 1, pending: 1 });
  assert.equal(workspaces[0].pr.state, "open");
});
