// Turns raw Paseo SDK payloads (workspaces, agent directory entries, schedules)
// into the flat model the dashboard renders. Pure: no I/O, `now` is injected.

/** Task states shown in the UI, in display order. */
export const TASK_STATES = ["needs_input", "failed", "running", "review", "todo", "done"];

const STATE_PRIORITY = { needs_input: 0, failed: 1, running: 2, review: 3, todo: 4, done: 5 };

/**
 * Same precedence as the daemon's deriveAgentStateBucket
 * (packages/protocol/src/agent-state-bucket.ts), with two dashboard additions:
 * `initializing` counts as running and archived agents are done.
 */
export function deriveTaskState(agent) {
  // Archived agents need nothing from you anymore; their outcome lives in `outcome`.
  if (agent.archivedAt) return "done";
  const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions.length : 0;
  if (pending > 0 || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.requiresAttention) return "review";
  return "done";
}

/** Maps the daemon's workspace bucket onto dashboard states. */
export function mapWorkspaceStatus(status) {
  switch (status) {
    case "needs_input":
      return "needs_input";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "attention":
      return "review";
    default:
      return "done";
  }
}

function ms(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function normPath(p) {
  return typeof p === "string" ? p.replace(/\/+$/, "") : "";
}

function describeCadence(cadence) {
  if (!cadence) return "";
  if (cadence.type === "cron") return `cron ${cadence.expression}`;
  if (cadence.type === "every") {
    const m = Math.round(cadence.everyMs / 60000);
    if (m < 60) return `toutes les ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `toutes les ${h} h`;
    return `tous les ${Math.round(h / 24)} jours`;
  }
  return "";
}

function workspaceFromDescriptor(w) {
  const pr = w.githubRuntime?.pullRequest ?? null;
  const checks = Array.isArray(pr?.checks) ? pr.checks : [];
  return {
    id: w.id,
    name: w.name,
    projectId: w.projectId,
    project: w.projectDisplayName,
    projectRoot: w.projectRootPath,
    directory: w.workspaceDirectory ?? w.projectRootPath,
    kind: w.workspaceKind,
    branch: w.gitRuntime?.currentBranch ?? null,
    dirty: w.gitRuntime?.isDirty ?? null,
    status: mapWorkspaceStatus(w.status),
    statusEnteredAt: w.statusEnteredAt ?? null,
    activityAt: w.activityAt ?? null,
    pinned: Boolean(w.pinnedAt),
    labels: Array.isArray(w.labels) ? w.labels : [],
    diff: w.diffStat ? { additions: w.diffStat.additions, deletions: w.diffStat.deletions } : null,
    pr: pr
      ? {
          number: pr.number ?? null,
          url: pr.url,
          title: pr.title,
          state: pr.isMerged ? "merged" : String(pr.state || "").toLowerCase(),
          draft: Boolean(pr.isDraft),
          checks: {
            total: checks.length,
            failed: checks.filter((c) => c.status === "failure").length,
            pending: checks.filter((c) => c.status === "pending").length,
          },
        }
      : null,
    synthetic: false,
  };
}

function taskFromAgent(agent, workspaceId, now) {
  const state = deriveTaskState(agent);
  const created = ms(agent.createdAt);
  const updated = ms(agent.updatedAt);
  const turnStarted = ms(agent.activeTurn?.startedAt);
  const attentionAt = ms(agent.attentionTimestamp);
  const finishedAt =
    state === "running" || state === "needs_input" ? null : (attentionAt ?? ms(agent.archivedAt) ?? updated);
  const usage = agent.lastUsage ?? {};
  const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : [];
  const firstPending = pending[0];
  return {
    id: agent.id,
    shortId: agent.id.slice(0, 8),
    workspaceId,
    title: agent.title?.trim() || "Agent sans titre",
    provider: agent.provider,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    mode: agent.currentModeId ?? null,
    state,
    // success | failed, for finished work (metrics); null while still active.
    outcome:
      state === "failed" || (agent.archivedAt && agent.status === "error")
        ? "failed"
        : state === "running" || state === "needs_input"
          ? null
          : "success",
    rawStatus: agent.status,
    attentionReason: agent.attentionReason ?? null,
    pendingCount: pending.length,
    pendingSummary: firstPending ? firstPending.title || firstPending.name : null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.lastUserMessageAt ?? null,
    turnStartedAt: agent.activeTurn?.startedAt ?? null,
    attentionAt: agent.attentionTimestamp ?? null,
    finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
    archivedAt: agent.archivedAt ?? null,
    lastError: agent.lastError ?? null,
    // Active tasks: time in the current turn. Others: created → finished.
    elapsedMs:
      state === "running" || state === "needs_input"
        ? now - (turnStarted ?? created ?? now)
        : finishedAt && created
          ? Math.max(0, finishedAt - created)
          : null,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: usage.totalCostUsd ?? 0,
      contextUsed: usage.contextWindowUsedTokens ?? null,
      contextMax: usage.contextWindowMaxTokens ?? null,
    },
    labels: agent.labels ?? {},
    providerUnavailable: Boolean(agent.providerUnavailable),
    scheduled: false,
  };
}

/**
 * @param {object} raw
 * @param {Array} raw.workspaces  WorkspaceDescriptorPayload[]
 * @param {Array} raw.agentEntries FetchAgentsEntry[] ({ agent, project })
 * @param {Array} [raw.schedules] ScheduleSummary[]
 * @param {number} now epoch ms
 */
export function normalize({ workspaces = [], agentEntries = [], schedules = [] }, now = Date.now()) {
  const wsList = workspaces.map(workspaceFromDescriptor);
  const byId = new Map(wsList.map((w) => [w.id, w]));
  const byDir = new Map();
  for (const w of wsList) {
    byDir.set(normPath(w.directory), w.id);
    if (!byDir.has(normPath(w.projectRoot))) byDir.set(normPath(w.projectRoot), w.id);
  }

  // Agents whose workspace was archived still matter for history and metrics.
  function ensureWorkspace(entry) {
    const agent = entry.agent;
    if (agent.workspaceId && byId.has(agent.workspaceId)) return agent.workspaceId;
    const fromDir = byDir.get(normPath(agent.cwd));
    if (fromDir) return fromDir;
    const id = agent.workspaceId || `dir:${normPath(agent.cwd)}`;
    if (!byId.has(id)) {
      const project = entry.project ?? {};
      const synthetic = {
        id,
        name: project.workspaceName || normPath(agent.cwd).split("/").pop() || agent.cwd,
        projectId: project.projectKey ?? id,
        project: project.projectName ?? "Hors projet",
        projectRoot: agent.cwd,
        directory: agent.cwd,
        kind: "directory",
        branch: null,
        dirty: null,
        status: "done",
        statusEnteredAt: null,
        activityAt: null,
        pinned: false,
        labels: [],
        diff: null,
        pr: null,
        synthetic: true,
      };
      wsList.push(synthetic);
      byId.set(id, synthetic);
      byDir.set(normPath(agent.cwd), id);
    }
    return id;
  }

  const tasks = [];
  const seen = new Set();
  for (const entry of agentEntries) {
    const agent = entry?.agent;
    if (!agent?.id || seen.has(agent.id) || agent.internal) continue;
    seen.add(agent.id);
    tasks.push(taskFromAgent(agent, ensureWorkspace(entry), now));
  }

  // Upcoming scheduled runs are the "to do" lane.
  const todos = [];
  for (const s of schedules) {
    if (s.status !== "active" || !s.nextRunAt) continue;
    let workspaceId = null;
    let provider = null;
    if (s.target?.type === "new-agent") {
      workspaceId = byDir.get(normPath(s.target.config.cwd)) ?? null;
      provider = s.target.config.provider;
    } else if (s.target?.type === "agent") {
      const t = tasks.find((x) => x.id === s.target.agentId);
      workspaceId = t?.workspaceId ?? null;
      provider = t?.provider ?? null;
    }
    todos.push({
      id: `schedule:${s.id}`,
      scheduleId: s.id,
      shortId: s.id.slice(0, 8),
      workspaceId,
      title: s.name?.trim() || s.prompt.split("\n")[0].slice(0, 90),
      prompt: s.prompt,
      provider,
      state: "todo",
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      cadence: describeCadence(s.cadence),
      scheduled: true,
    });
  }

  // Workspace status: trust the daemon, but derive it for synthetic ones.
  for (const w of wsList) {
    const own = tasks.filter((t) => t.workspaceId === w.id && !t.archivedAt);
    w.taskCount = tasks.filter((t) => t.workspaceId === w.id).length;
    w.todoCount = todos.filter((t) => t.workspaceId === w.id).length;
    if (w.synthetic) {
      w.status = own.reduce(
        (best, t) => (STATE_PRIORITY[t.state] < STATE_PRIORITY[best] ? t.state : best),
        "done",
      );
    }
    const lastTask = own.reduce((m, t) => Math.max(m, ms(t.updatedAt) ?? 0), 0);
    w.lastActivityAt = new Date(Math.max(ms(w.activityAt) ?? 0, lastTask) || now).toISOString();
  }

  return { workspaces: wsList, tasks, todos };
}
