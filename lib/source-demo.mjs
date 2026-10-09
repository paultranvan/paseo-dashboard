// Demo source: a small simulated fleet that produces payloads shaped exactly
// like the Paseo SDK's (WorkspaceDescriptorPayload, agent directory entries,
// ScheduleSummary). Lets you try the dashboard without a daemon, and keeps the
// normalize path exercised end to end.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PROVIDERS = [
  { provider: "claude", model: "opus", weight: 5 },
  { provider: "codex", model: "gpt-5.5", weight: 4 },
  { provider: "opencode", model: "kimi-k2", weight: 2 },
  { provider: "copilot", model: "gpt-5-mini", weight: 1 },
];

const PROJECTS = [
  {
    id: "proj-storefront",
    name: "storefront",
    root: "/home/dev/code/storefront",
    kind: "git",
    workspaces: [
      { slug: "main", branch: "main", kind: "local_checkout" },
      { slug: "fix-checkout-tax", branch: "fix/checkout-tax-rounding", kind: "worktree", pr: 412 },
      { slug: "redesign-settings", branch: "feat/settings-redesign", kind: "worktree", pr: 418 },
      { slug: "deps-sweep", branch: "chore/deps-october", kind: "worktree" },
    ],
  },
  {
    id: "proj-gateway",
    name: "api-gateway",
    root: "/home/dev/code/api-gateway",
    kind: "git",
    workspaces: [
      { slug: "main", branch: "main", kind: "local_checkout" },
      { slug: "rate-limit-redis", branch: "feat/rate-limit-redis", kind: "worktree", pr: 87 },
      { slug: "oauth-pkce", branch: "feat/oauth-pkce", kind: "worktree" },
    ],
  },
  {
    id: "proj-docs",
    name: "docs-site",
    root: "/home/dev/code/docs-site",
    kind: "git",
    workspaces: [
      { slug: "main", branch: "main", kind: "local_checkout" },
      { slug: "i18n-fr", branch: "feat/i18n-fr", kind: "worktree", pr: 31 },
    ],
  },
  {
    id: "proj-infra",
    name: "infra",
    root: "/home/dev/infra/terraform",
    kind: "non_git",
    workspaces: [{ slug: "terraform", branch: null, kind: "directory" }],
  },
];

const TITLES = {
  "storefront/main": [
    "Audit des requêtes N+1 du catalogue",
    "Mettre à jour le guide de contribution",
    "Revue du diff de la release 3.8",
  ],
  "storefront/fix-checkout-tax": [
    "Corriger l'arrondi de TVA au panier",
    "Ajouter des tests sur les paniers multi-devises",
    "Revue croisée du correctif TVA",
  ],
  "storefront/redesign-settings": [
    "Refonte de l'écran Paramètres",
    "Extraire les composants de formulaire",
    "Snapshot tests des nouveaux écrans",
    "Accessibilité clavier des onglets",
  ],
  "storefront/deps-sweep": ["Monter React Router en v7", "Purger les dépendances inutilisées"],
  "api-gateway/main": ["Cartographier les middlewares", "Expliquer la panne de mardi"],
  "api-gateway/rate-limit-redis": [
    "Rate limiting par clé API sur Redis",
    "Benchmark du limiteur sous charge",
    "Documenter les quotas",
  ],
  "api-gateway/oauth-pkce": ["Implémenter le flux OAuth PKCE", "Tests e2e du login PKCE"],
  "docs-site/main": ["Corriger les liens morts"],
  "docs-site/i18n-fr": ["Traduire la section Démarrage en français", "Relire la terminologie FR"],
  "infra/terraform": ["Plan Terraform du cluster staging", "Rotation des secrets CI"],
};

const PERMISSIONS = [
  { name: "Bash", title: "Exécuter npm install --save redis" },
  { name: "Edit", title: "Modifier .github/workflows/ci.yml" },
  { name: "Bash", title: "Lancer terraform apply sur staging" },
  { name: "plan", title: "Valider le plan d'implémentation" },
];

const ERRORS = [
  "Provider exited with code 1: rate limit exceeded",
  "Tests failing: 3 of 214 in checkout.spec.ts",
  "Context window exhausted",
];

function uuid(rand) {
  const h = () => Math.floor(rand() * 16).toString(16);
  const s = (n) => Array.from({ length: n }, h).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-a${s(3)}-${s(12)}`;
}

function pickProvider(rand) {
  const total = PROVIDERS.reduce((a, p) => a + p.weight, 0);
  let r = rand() * total;
  for (const p of PROVIDERS) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PROVIDERS[0];
}

function iso(t) {
  return new Date(t).toISOString();
}

export function createDemoSource({ seed = 7, frozen = false, now: fixedNow } = {}) {
  const rand = mulberry32(seed);
  const t0 = fixedNow ?? Date.now();
  const clock = () => (frozen ? t0 : Date.now());

  const workspaces = [];
  for (const p of PROJECTS) {
    for (const w of p.workspaces) {
      const dir = w.kind === "worktree" ? `${p.root}/.paseo/worktrees/${w.slug}` : p.root;
      workspaces.push({
        key: `${p.name}/${w.slug}`,
        project: p,
        id: `ws-${p.name}-${w.slug}`,
        name: w.slug,
        dir,
        branch: w.branch,
        kind: w.kind,
        pr: w.pr ?? null,
        createdAt: t0 - (3 + Math.floor(rand() * 12)) * DAY,
        diff: w.kind === "worktree" ? { additions: 20 + Math.floor(rand() * 600), deletions: Math.floor(rand() * 240) } : null,
      });
    }
  }

  /** @type {Map<string, object>} */
  const agents = new Map();

  function makeAgent(ws, { createdAt, status, title }) {
    const pv = pickProvider(rand);
    const id = uuid(rand);
    const inTok = 20_000 + Math.floor(rand() * 900_000);
    const outTok = Math.floor(inTok * (0.04 + rand() * 0.08));
    const cost = pv.provider === "copilot" ? 0 : (inTok / 1e6) * (pv.provider === "claude" ? 5 : 2.5) + (outTok / 1e6) * 15;
    const a = {
      id,
      provider: pv.provider,
      cwd: ws.dir,
      workspaceId: ws.id,
      model: pv.model,
      createdAt: iso(createdAt),
      updatedAt: iso(createdAt),
      lastUserMessageAt: iso(createdAt),
      status,
      activeTurn: null,
      capabilities: {},
      currentModeId: "default",
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      lastUsage: {
        inputTokens: inTok,
        cachedInputTokens: Math.floor(inTok * (0.3 + rand() * 0.5)),
        outputTokens: outTok,
        totalCostUsd: Math.round(cost * 100) / 100,
        contextWindowMaxTokens: pv.provider === "claude" ? 1_000_000 : 400_000,
        contextWindowUsedTokens: Math.floor(30_000 + rand() * 200_000),
      },
      title,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };
    agents.set(id, a);
    return a;
  }

  function finish(a, at, { error = false, archive = false, attention = true } = {}) {
    a.status = error ? "error" : "idle";
    a.activeTurn = null;
    a.pendingPermissions = [];
    a.updatedAt = iso(at);
    a.requiresAttention = attention;
    a.attentionReason = attention ? (error ? "error" : "finished") : null;
    a.attentionTimestamp = attention ? iso(at) : null;
    if (error) a.lastError = ERRORS[Math.floor(rand() * ERRORS.length)];
    if (archive) {
      a.archivedAt = iso(at + 5 * MIN + rand() * HOUR);
      a.requiresAttention = false;
      a.attentionReason = null;
    }
  }

  function start(a, at) {
    a.status = "running";
    a.activeTurn = { turnId: uuid(rand), startedAt: iso(at) };
    a.updatedAt = iso(at);
    a.requiresAttention = false;
    a.attentionReason = null;
    a.attentionTimestamp = null;
  }

  function askPermission(a, at) {
    const p = PERMISSIONS[Math.floor(rand() * PERMISSIONS.length)];
    a.pendingPermissions = [{ id: uuid(rand), provider: a.provider, kind: p.name === "plan" ? "plan" : "tool", ...p }];
    a.requiresAttention = true;
    a.attentionReason = "permission";
    a.attentionTimestamp = iso(at);
    a.updatedAt = iso(at);
  }

  // 14 days of history, denser on weekdays and working hours.
  for (let d = 13; d >= 0; d--) {
    const dayStart = new Date(t0 - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const weekday = dayStart.getDay() % 6 !== 0;
    const count = weekday ? 5 + Math.floor(rand() * 7) : Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const hour = 8 + Math.floor(rand() * 11) + (rand() < 0.1 ? 4 : 0);
      const createdAt = dayStart.getTime() + hour * HOUR + Math.floor(rand() * HOUR);
      if (createdAt > t0 - 2 * HOUR) continue;
      const ws = workspaces[Math.floor(rand() * workspaces.length)];
      const titles = TITLES[ws.key];
      const a = makeAgent(ws, { createdAt, status: "idle", title: titles[Math.floor(rand() * titles.length)] });
      const duration = (4 + rand() * 70) * MIN;
      finish(a, createdAt + duration, { error: rand() < 0.09, archive: true });
    }
  }

  // The current picture: something in every state.
  const live = [
    ["storefront/redesign-settings", "running", 0, 38],
    ["storefront/redesign-settings", "running", 1, 12],
    ["storefront/redesign-settings", "review", 2, 25],
    ["storefront/fix-checkout-tax", "needs_input", 1, 9],
    ["storefront/fix-checkout-tax", "review", 0, 70],
    ["api-gateway/rate-limit-redis", "running", 0, 54],
    ["api-gateway/rate-limit-redis", "needs_input", 1, 22],
    ["api-gateway/oauth-pkce", "failed", 0, 95],
    ["api-gateway/main", "done", 1, 180],
    ["docs-site/i18n-fr", "running", 0, 6],
    ["docs-site/i18n-fr", "done", 1, 140],
    ["infra/terraform", "needs_input", 0, 31],
    ["storefront/deps-sweep", "done", 0, 300],
  ];
  for (const [key, state, titleIdx, minutesAgo] of live) {
    const ws = workspaces.find((w) => w.key === key);
    const at = t0 - minutesAgo * MIN;
    const a = makeAgent(ws, { createdAt: at - 10 * MIN, status: "idle", title: TITLES[key][titleIdx] });
    if (state === "running") start(a, at);
    if (state === "needs_input") {
      start(a, at - 8 * MIN);
      askPermission(a, at);
    }
    if (state === "review") finish(a, at);
    if (state === "failed") finish(a, at, { error: true });
    if (state === "done") finish(a, at, { attention: false });
  }

  const schedules = [
    {
      key: "storefront/main",
      name: "Audit hebdo des dépendances",
      prompt: "Liste les dépendances obsolètes et ouvre une PR de mise à jour.",
      cadence: { type: "cron", expression: "0 9 * * 1", timezone: "Europe/Paris" },
      inMin: 3 * 24 * 60 - 20,
    },
    {
      key: "api-gateway/main",
      name: "Revue des logs d'erreur",
      prompt: "Analyse les erreurs 5xx des dernières 24 h et propose des correctifs.",
      cadence: { type: "every", everyMs: 24 * HOUR },
      inMin: 95,
    },
    {
      key: "docs-site/i18n-fr",
      name: null,
      prompt: "Relire la section API traduite et harmoniser la terminologie\navec le glossaire.",
      cadence: { type: "every", everyMs: 6 * HOUR },
      inMin: 40,
    },
    {
      key: "infra/terraform",
      name: "Drift Terraform",
      prompt: "Lance terraform plan et signale toute dérive.",
      cadence: { type: "cron", expression: "30 7 * * *", timezone: "Europe/Paris" },
      inMin: 17 * 60,
    },
  ].map((s, i) => {
    const ws = workspaces.find((w) => w.key === s.key);
    return {
      id: `sched${i}-${uuid(rand)}`,
      name: s.name,
      prompt: s.prompt,
      cadence: s.cadence,
      target: { type: "new-agent", config: { provider: i % 2 ? "codex" : "claude", cwd: ws.dir } },
      status: "active",
      createdAt: iso(t0 - 10 * DAY),
      updatedAt: iso(t0 - DAY),
      nextRunAt: iso(t0 + s.inMin * MIN),
      lastRunAt: iso(t0 - DAY),
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
    };
  });

  // Live evolution: one random event per tick.
  let lastTick = t0;
  function tick() {
    if (frozen) return;
    const now = Date.now();
    if (now - lastTick < 6000) return;
    lastTick = now;
    const all = [...agents.values()].filter((a) => !a.archivedAt);
    const running = all.filter((a) => a.status === "running" && a.pendingPermissions.length === 0);
    const waiting = all.filter((a) => a.pendingPermissions.length > 0);
    const reviewed = all.filter((a) => a.attentionReason === "finished");
    const r = rand();
    if (r < 0.3 && running.length) {
      finish(running[Math.floor(rand() * running.length)], now, { error: rand() < 0.15 });
    } else if (r < 0.45 && running.length) {
      askPermission(running[Math.floor(rand() * running.length)], now);
    } else if (r < 0.6 && waiting.length) {
      const a = waiting[0];
      a.pendingPermissions = [];
      start(a, now);
    } else if (r < 0.75 && reviewed.length) {
      const a = reviewed[0];
      a.requiresAttention = false;
      a.attentionReason = null;
    } else if (running.length < 6) {
      const ws = workspaces[Math.floor(rand() * workspaces.length)];
      const titles = TITLES[ws.key];
      const a = makeAgent(ws, { createdAt: now, status: "idle", title: titles[Math.floor(rand() * titles.length)] });
      start(a, now);
    }
  }

  function workspacePayload(ws) {
    const p = ws.project;
    const prState = ws.pr ? (ws.key.includes("checkout") ? "OPEN" : "OPEN") : null;
    return {
      id: ws.id,
      projectId: p.id,
      projectDisplayName: p.name,
      projectRootPath: p.root,
      workspaceDirectory: ws.dir,
      projectKind: p.kind,
      workspaceKind: ws.kind,
      name: ws.name,
      title: null,
      pinnedAt: null,
      labels: [],
      archivingAt: null,
      // Same aggregation the daemon does: highest-priority root agent wins.
      status: (() => {
        const order = ["needs_input", "failed", "running", "attention", "done"];
        let best = "done";
        for (const a of agents.values()) {
          if (a.workspaceId !== ws.id || a.archivedAt) continue;
          let b = "done";
          if (a.pendingPermissions.length || a.attentionReason === "permission") b = "needs_input";
          else if (a.status === "error" || a.attentionReason === "error") b = "failed";
          else if (a.status === "running") b = "running";
          else if (a.requiresAttention) b = "attention";
          if (order.indexOf(b) < order.indexOf(best)) best = b;
        }
        return best;
      })(),
      statusEnteredAt: null,
      activityAt: (() => {
        let m = 0;
        for (const a of agents.values()) if (a.workspaceId === ws.id) m = Math.max(m, Date.parse(a.updatedAt));
        return m ? iso(m) : null;
      })(),
      diffStat: ws.diff,
      scripts: [],
      gitRuntime: ws.branch ? { currentBranch: ws.branch, isDirty: ws.kind === "worktree" } : null,
      githubRuntime: ws.pr
        ? {
            featuresEnabled: true,
            pullRequest: {
              number: ws.pr,
              url: `https://github.com/example/${p.name}/pull/${ws.pr}`,
              title: ws.branch,
              state: prState,
              baseRefName: "main",
              headRefName: ws.branch,
              isMerged: false,
              isDraft: ws.key.includes("redesign"),
              checks: [
                { name: "lint", status: "success", url: null },
                { name: "test", status: ws.key.includes("checkout") ? "failure" : "success", url: null },
                { name: "build", status: ws.key.includes("i18n") ? "pending" : "success", url: null },
              ],
            },
          }
        : null,
    };
  }

  return {
    kind: "demo",
    label: frozen ? "démo (figée)" : "démo",
    now: clock,
    async fetch() {
      tick();
      return {
        workspaces: workspaces.map(workspacePayload),
        agentEntries: [...agents.values()].map((agent) => ({
          agent: structuredClone(agent),
          project: { projectKey: agent.workspaceId, projectName: "", workspaceName: null, checkout: {} },
        })),
        schedules: structuredClone(schedules),
      };
    },
    async close() {},
  };
}
