// Paseo dashboard UI. Vanilla JS, no build step.
// Receives snapshots from the server over SSE and re-renders.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const STATES = {
  needs_input: { label: "À valider", hint: "attend votre réponse", order: 0 },
  failed: { label: "En erreur", hint: "à relancer ou abandonner", order: 1 },
  running: { label: "En cours", hint: "agents au travail", order: 2 },
  review: { label: "À relire", hint: "fini, pas encore vu", order: 3 },
  todo: { label: "À faire", hint: "planifié", order: 4 },
  done: { label: "Terminé", hint: "", order: 5 },
};
const STATE_KEYS = Object.keys(STATES);

const WINDOWS = {
  "12h": { span: 12 * HOUR, label: "12 h", short: "12 h" },
  "24h": { span: 24 * HOUR, label: "24 h", short: "24 h" },
  "7d": { span: 7 * DAY, label: "7 jours", short: "7 j" },
};

const PROVIDERS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  copilot: "Copilot",
  pi: "Pi",
  antigravity: "Antigravity",
  "muse-code": "Muse Code",
};

// ---------------------------------------------------------------- utilities

const $ = (sel, root = document) => root.querySelector(sel);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function t(iso) {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? null : v;
}

function providerName(p) {
  if (!p) return "—";
  return PROVIDERS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

const nf = new Intl.NumberFormat("fr-FR");
const nfCompact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 2,
});
const pct = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const hourFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const weekdayHourFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", hour: "2-digit" });

function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")}`;
  const d = Math.floor(h / 24);
  return `${d} j ${h % 24} h`;
}

function relative(ms, now) {
  if (ms == null) return "—";
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return "à l'instant";
  const d = duration(abs);
  return diff < 0 ? `il y a ${d}` : `dans ${d}`;
}

function money(v) {
  if (!v) return "0 $";
  return v < 0.01 ? "< 0,01 $" : usd.format(v);
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`paseo-dash:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`paseo-dash:${key}`, JSON.stringify(value));
    } catch {}
  },
};

// ---------------------------------------------------------------- icons

function stateIcon(state, size = 16) {
  const s = size;
  const common = `class="st-icon" width="${s}" height="${s}" viewBox="0 0 16 16" aria-hidden="true"`;
  switch (state) {
    case "needs_input":
      return `<svg ${common}><path d="M8 1.5 14.5 8 8 14.5 1.5 8z" fill="currentColor"/><path d="M8 5v3.6" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="10.9" r="0.95" fill="var(--surface)"/></svg>`;
    case "failed":
      return `<svg ${common}><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    case "running":
      return `<svg ${common}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/><path class="spin" d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "review":
      return `<svg ${common}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>`;
    case "todo":
      return `<svg ${common}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2.2"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    default:
      return `<svg ${common}><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="m5.2 8.2 1.9 1.9 3.8-3.9" fill="none" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
}

function chip(state) {
  return `<span class="chip" data-state="${state}">${stateIcon(state, 14)}${STATES[state].label}</span>`;
}

const ICON_CARET = `<svg class="caret" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_BRANCH = `<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="5.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 5.3v5.4M12 7.3c0 3-8 1.5-8 3.4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
const ICON_PR = `<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 5.3v5.4M12 10.7V6a2 2 0 0 0-2-2H7.5m1.8-1.8L7.5 4l1.8 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_SEARCH = `<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.6 10.6 3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// ---------------------------------------------------------------- app state

const ui = {
  snap: null,
  route: "tasks",
  view: store.get("view", "lanes"),
  window: store.get("window", "24h"),
  filter: new Set(),
  query: "",
  hideQuiet: store.get("hideQuiet", false),
  openOverrides: new Map(Object.entries(store.get("open", {}))),
  expandedLists: new Set(),
  selected: null,
};

function nowMs() {
  return t(ui.snap?.now) ?? Date.now();
}

// Tasks + scheduled todos that belong on screen for the current time window.
function visibleItems() {
  const snap = ui.snap;
  if (!snap) return [];
  const now = nowMs();
  const from = now - WINDOWS[ui.window].span;
  const items = [];
  for (const task of snap.data.tasks) {
    if (task.archivedAt || task.state === "done") {
      const end = t(task.finishedAt) ?? t(task.updatedAt);
      if (end == null || end < from) continue;
    }
    items.push(task);
  }
  for (const todo of snap.data.todos) items.push(todo);
  return items;
}

function matchesQuery(item, ws) {
  const q = ui.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.title, item.provider, providerName(item.provider), item.model, ws?.name, ws?.project, ws?.branch, item.shortId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

function workspaceMap() {
  return new Map((ui.snap?.data.workspaces ?? []).map((w) => [w.id, w]));
}

function sortItems(a, b) {
  const d = STATES[a.state].order - STATES[b.state].order;
  if (d) return d;
  if (a.state === "todo") return t(a.nextRunAt) - t(b.nextRunAt);
  return (t(b.updatedAt) ?? 0) - (t(a.updatedAt) ?? 0);
}

// ---------------------------------------------------------------- top bar

function renderConn() {
  const el = $("#conn");
  const snap = ui.snap;
  if (!snap) return;
  const c = snap.connection;
  el.dataset.status = c.status;
  const src = snap.source.kind === "demo" ? `Données de ${snap.source.label}` : snap.source.label;
  let text;
  if (c.status === "ok") text = `En direct · ${src}`;
  else if (c.status === "error") text = `Hors ligne · ${src}`;
  else text = `Connexion · ${src}`;
  el.querySelector(".conn-label").textContent = text;
  el.title =
    c.status === "error"
      ? `Dernière erreur : ${c.error}`
      : `Mis à jour ${c.lastSuccessAt ? hourFmt.format(t(c.lastSuccessAt)) : "—"}, toutes les ${snap.pollMs / 1000} s`;
}

function renderBanner() {
  const c = ui.snap?.connection;
  if (!c || c.status !== "error") return "";
  const last = c.lastSuccessAt
    ? `Les données affichées datent de ${hourFmt.format(t(c.lastSuccessAt))}.`
    : "Aucune donnée reçue pour l'instant.";
  return `<div class="banner" role="alert">${stateIcon("failed", 18)}<div><strong>Le daemon Paseo ne répond pas.</strong>
    ${esc(last)} Vérifiez qu'il tourne (<code>paseo daemon status</code>) et l'adresse ${esc(ui.snap.source.label)}. Nouvelle tentative toutes les ${ui.snap.pollMs / 1000} s.<br><small>${esc(c.error)}</small></div></div>`;
}

// ---------------------------------------------------------------- tasks page

function renderTriage(items) {
  const counts = Object.fromEntries(STATE_KEYS.map((k) => [k, 0]));
  for (const it of items) counts[it.state]++;
  return `<div class="triage" role="group" aria-label="Filtrer par état">${STATE_KEYS.map((k) => {
    const hint = k === "done" ? `sur ${WINDOWS[ui.window].label}` : STATES[k].hint;
    return `<button type="button" data-state="${k}" data-filter="${k}" aria-pressed="${ui.filter.has(k)}" data-zero="${counts[k] === 0}">
      <span class="count num" data-testid="count-${k}">${counts[k]}</span>
      <span class="label">${stateIcon(k)}${STATES[k].label}</span>
      <span class="hint">${esc(hint)}</span>
    </button>`;
  }).join("")}</div>`;
}

function renderToolbar(shownCount, totalCount) {
  const filterNote =
    ui.filter.size || ui.query
      ? `<span class="filter-note">${shownCount} sur ${totalCount} affichées · <button type="button" class="link-btn" data-action="clear-filters">Tout afficher</button></span>`
      : "";
  return `<div class="toolbar">
    <label class="search">${ICON_SEARCH}<span class="sr-only">Rechercher</span>
      <input type="search" id="q" placeholder="Rechercher une tâche, un workspace, une branche…" value="${esc(ui.query)}" autocomplete="off"></label>
    <div class="seg" role="group" aria-label="Disposition">
      <button type="button" data-view="lanes" aria-pressed="${ui.view === "lanes"}">Par workspace</button>
      <button type="button" data-view="columns" aria-pressed="${ui.view === "columns"}">Par état</button>
    </div>
    <div class="seg" role="group" aria-label="Période">
      ${Object.entries(WINDOWS)
        .map(([k, w]) => `<button type="button" data-window="${k}" aria-pressed="${ui.window === k}">${w.short}</button>`)
        .join("")}
    </div>
    ${ui.view === "lanes" ? `<label class="check"><input type="checkbox" id="hideQuiet" ${ui.hideQuiet ? "checked" : ""}> Masquer les workspaces au repos</label>` : ""}
    <span class="grow"></span>
    ${filterNote}
  </div>`;
}

function niceTicks(from, to) {
  const span = to - from;
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
  const step = steps.find((s) => span / s <= 9) ?? DAY;
  const ticks = [];
  const d = new Date(from);
  if (step < DAY) {
    d.setMinutes(0, 0, 0);
    while (d.getTime() < from || d.getHours() % (step / HOUR) !== 0) d.setTime(d.getTime() + HOUR);
  } else {
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < from) d.setDate(d.getDate() + 1);
  }
  for (let x = d.getTime(); x <= to; x += step) {
    const date = new Date(x);
    const label =
      step >= DAY ? dayFmt.format(date) : date.getHours() === 0 ? dayFmt.format(date) : `${date.getHours()} h`;
    ticks.push({ x, label });
  }
  return ticks;
}

function timeScale() {
  const now = nowMs();
  const span = WINDOWS[ui.window].span;
  const from = now - span * 0.82;
  const to = now + span * 0.18;
  return { now, from, to, x: (v) => ((Math.min(Math.max(v, from), to) - from) / (to - from)) * 100 };
}

function packRows(segments) {
  const rows = [];
  for (const s of segments.sort((a, b) => a.start - b.start)) {
    let r = rows.findIndex((end) => end <= s.startPct - 0.8);
    if (r === -1) {
      r = rows.length;
      rows.push(0);
    }
    rows[r] = s.endPct;
    s.row = r;
  }
  return rows.length;
}

function tipForTask(item, ws) {
  const now = nowMs();
  const lines = [`<strong>${esc(item.title)}</strong>`, `<div class="t-row"><span>${esc(STATES[item.state].label)}</span><span>${esc(ws?.name ?? "")}</span></div>`];
  if (item.state === "todo") {
    lines.push(`<div class="t-row"><span>Prochaine exécution</span><span>${esc(relative(t(item.nextRunAt), now))}</span></div>`);
  } else {
    lines.push(`<div class="t-row"><span>Agent</span><span>${esc(providerName(item.provider))}</span></div>`);
    lines.push(`<div class="t-row"><span>Démarré</span><span>${esc(relative(t(item.createdAt), now))}</span></div>`);
    if (item.elapsedMs != null) lines.push(`<div class="t-row"><span>Durée</span><span>${esc(duration(item.elapsedMs))}</span></div>`);
  }
  return lines.join("");
}

function laneTrack(items, ws, scale) {
  const segs = [];
  const marks = [];
  for (const it of items) {
    if (it.state === "todo") {
      const at = t(it.nextRunAt);
      marks.push({ it, pct: scale.x(at), beyond: at > scale.to });
      continue;
    }
    const start = t(it.createdAt) ?? scale.now;
    const end = it.state === "running" || it.state === "needs_input" ? scale.now : (t(it.finishedAt) ?? t(it.updatedAt) ?? scale.now);
    if (end < scale.from) continue;
    const startPct = scale.x(start);
    const endPct = Math.max(scale.x(end), startPct + 0.4);
    segs.push({ it, start, startPct, endPct });
  }
  const rows = Math.max(1, packRows(segs));
  const rowH = 18;
  const height = Math.max(64, rows * rowH + 26);
  const top0 = (height - rows * rowH) / 2 + 3;
  const ticks = niceTicks(scale.from, scale.to);
  const nowPct = scale.x(scale.now);
  const dim = ui.filter.size > 0;
  return `<div class="track" style="min-height:${height}px">
    <div class="future" style="left:${nowPct}%"></div>
    ${ticks.map((tk) => `<div class="grid-line" style="left:${scale.x(tk.x)}%"></div>`).join("")}
    <div class="now-line" style="left:${nowPct}%"></div>
    ${segs
      .map(
        (s) =>
          `<button type="button" class="seg-bar" data-state="${s.it.state}" data-task="${esc(s.it.id)}" data-tip="${esc(tipForTask(s.it, ws))}"
            aria-label="${esc(`${s.it.title}, ${STATES[s.it.state].label}`)}"
            style="left:${s.startPct}%;width:${Math.max(0.4, s.endPct - s.startPct)}%;top:${top0 + s.row * rowH}px;${dim && !ui.filter.has(s.it.state) ? "opacity:.18" : ""}"></button>`,
      )
      .join("")}
    ${marks
      .map(
        (m) =>
          `<button type="button" class="todo-mark${m.beyond ? " beyond" : ""}" data-task="${esc(m.it.id)}" data-tip="${esc(tipForTask(m.it, ws))}"
            aria-label="${esc(`${m.it.title}, à faire ${relative(t(m.it.nextRunAt), scale.now)}`)}"
            style="left:${m.beyond ? 99 : m.pct}%;top:${height / 2 - 7}px;${dim && !ui.filter.has("todo") ? "opacity:.25" : ""}"></button>`,
      )
      .join("")}
    ${segs.length + marks.length === 0 ? `<span class="track-empty">Aucune activité sur ${WINDOWS[ui.window].label}</span>` : ""}
  </div>`;
}

function taskSubline(it, now) {
  switch (it.state) {
    case "needs_input":
      return `<small class="alert">${esc(it.pendingSummary ? `Demande : ${it.pendingSummary}` : "Attend votre réponse")}</small>`;
    case "failed":
      return `<small class="alert">${esc(it.lastError ?? "L'agent s'est arrêté sur une erreur")}</small>`;
    case "running":
      return `<small>Tour en cours depuis ${esc(duration(it.elapsedMs))}</small>`;
    case "review":
      return `<small>Terminé ${esc(relative(t(it.finishedAt), now))}, pas encore relu</small>`;
    case "todo":
      return `<small>${esc(it.cadence ? `Planifié, ${it.cadence}` : "Planifié")}</small>`;
    default:
      return `<small>${it.outcome === "failed" ? "Arrêté en erreur" : "Terminé"} ${esc(relative(t(it.finishedAt), now))}${it.archivedAt ? ", archivé" : ""}</small>`;
  }
}

function taskRow(it, now) {
  const when =
    it.state === "todo"
      ? relative(t(it.nextRunAt), now)
      : it.state === "running" || it.state === "needs_input"
        ? `lancé ${relative(t(it.createdAt), now)}`
        : relative(t(it.finishedAt ?? it.updatedAt), now);
  return `<li><button type="button" class="task-row" data-task="${esc(it.id)}" data-state="${it.state}">
    ${stateIcon(it.state)}
    <span class="task-title"><strong>${esc(it.title)}</strong>${taskSubline(it, now)}</span>
    <span class="cell-muted c-provider">${esc(providerName(it.provider))}${it.model ? ` <span class="mono">${esc(it.model)}</span>` : ""}</span>
    <span class="cell-muted c-when">${esc(when)}</span>
    <span class="cell-muted num">${it.state === "todo" ? "" : esc(duration(it.elapsedMs))}</span>
    <span class="cell-muted num cell-right c-cost">${it.state === "todo" ? "" : esc(money(it.usage?.costUsd))}</span>
  </button></li>`;
}

function laneOpen(ws, items) {
  if (ui.openOverrides.has(ws.id)) return ui.openOverrides.get(ws.id);
  if (ui.filter.size || ui.query) return true;
  return items.some((i) => i.state !== "done");
}

function wsStatusFor(ws, items) {
  // Daemon status for real workspaces; derived for directories without one.
  if (!ws.synthetic) return ws.status;
  return items.filter((i) => i.state !== "todo").sort(sortItems)[0]?.state ?? "done";
}

function renderLanes(groups, scale) {
  if (!groups.length) return emptyState();
  const ticks = niceTicks(scale.from, scale.to);
  const now = scale.now;
  let html = `<div class="board" id="lanes">
    <div class="axis-row" aria-hidden="true">
      <div class="axis-title">Workspace</div>
      <div class="axis">
        ${ticks.map((tk) => `<span class="tick" style="left:${scale.x(tk.x)}%">${esc(tk.label)}</span>`).join("")}
        <span class="now-label" style="left:${scale.x(now)}%">maintenant</span>
      </div>
    </div>`;
  for (const g of groups) {
    const counts = g.lanes.reduce((n, l) => n + l.items.filter((i) => i.state !== "done" && i.state !== "todo").length, 0);
    html += `<div class="project-head"><h2>${esc(g.project)}</h2><span>${g.lanes.length} workspace${g.lanes.length > 1 ? "s" : ""}${counts ? `, ${counts} tâche${counts > 1 ? "s" : ""} active${counts > 1 ? "s" : ""}` : ""}</span></div>`;
    for (const { ws, items, status } of g.lanes) {
      const open = laneOpen(ws, items);
      const listItems = items.slice().sort(sortItems);
      const expanded = ui.expandedLists.has(ws.id);
      const limit = expanded ? Infinity : 6;
      const shown = listItems.slice(0, limit);
      const hidden = listItems.length - shown.length;
      const pr = ws.pr
        ? `<a class="pr" href="${esc(ws.pr.url)}" target="_blank" rel="noopener" title="${esc(ws.pr.title)}">${ICON_PR}#${esc(ws.pr.number ?? "")}${ws.pr.checks.failed ? ` <span class="bad">${ws.pr.checks.failed} check${ws.pr.checks.failed > 1 ? "s" : ""} KO</span>` : ws.pr.draft ? " brouillon" : ""}</a>`
        : "";
      const diff = ws.diff ? `<span class="diff num"><span class="add">+${nf.format(ws.diff.additions)}</span> <span class="del">−${nf.format(ws.diff.deletions)}</span></span>` : "";
      html += `<section class="lane" data-ws="${esc(ws.id)}" data-open="${open}">
        <div class="lane-head">
          <button type="button" class="lane-meta" data-toggle="${esc(ws.id)}" aria-expanded="${open}" aria-controls="body-${esc(ws.id)}">
            ${ICON_CARET}
            <span class="ws-name">${esc(ws.name)}</span>
            <span class="ws-status">${chip(status)}</span>
            <span class="ws-sub">${ws.branch ? `<span class="branch mono" title="${esc(ws.branch)}">${ICON_BRANCH} ${esc(ws.branch)}</span>` : `<span class="branch mono" title="${esc(ws.directory)}">${esc(ws.directory.split("/").slice(-2).join("/"))}</span>`}${diff}${pr}</span>
          </button>
          ${laneTrack(items, ws, scale)}
        </div>
        <div class="lane-body" id="body-${esc(ws.id)}">
          ${
            listItems.length
              ? `<ul class="task-list">${shown.map((it) => taskRow(it, now)).join("")}${
                  hidden > 0
                    ? `<li class="more-row"><button type="button" class="link-btn" data-more="${esc(ws.id)}">Afficher ${hidden} tâche${hidden > 1 ? "s" : ""} de plus</button></li>`
                    : ""
                }</ul>`
              : `<p class="cell-muted">Aucune tâche sur ${WINDOWS[ui.window].label}. Lancez un agent dans ce workspace depuis Paseo.</p>`
          }
        </div>
      </section>`;
    }
  }
  return `${html}</div>`;
}

function renderColumns(items, wsById) {
  const now = nowMs();
  const keys = ui.filter.size ? STATE_KEYS.filter((k) => ui.filter.has(k)) : STATE_KEYS;
  return `<div class="columns" id="columns" style="grid-template-columns:repeat(${keys.length}, minmax(220px, 1fr))">${keys
    .map((k) => {
      const list = items.filter((i) => i.state === k).sort(sortItems);
      return `<section class="col" data-state="${k}" aria-label="${STATES[k].label}">
        <h3>${stateIcon(k)}${STATES[k].label}<span class="n num">${list.length}</span></h3>
        ${
          list.length
            ? list
                .map((it) => {
                  const ws = wsById.get(it.workspaceId);
                  const when =
                    it.state === "todo"
                      ? relative(t(it.nextRunAt), now)
                      : it.state === "running"
                        ? `depuis ${duration(it.elapsedMs)}`
                        : relative(t(it.finishedAt ?? it.updatedAt), now);
                  return `<button type="button" class="card" data-state="${k}" data-task="${esc(it.id)}">
                    <strong>${esc(it.title)}</strong>
                    <span class="meta"><span class="ws">${esc(ws ? `${ws.project} / ${ws.name}` : "Sans workspace")}</span><span>${esc(providerName(it.provider))}</span><span>${esc(when)}</span></span>
                  </button>`;
                })
                .join("")
            : `<p class="col-empty">${k === "needs_input" ? "Rien n'attend votre réponse." : "Aucune tâche."}</p>`
        }
      </section>`;
    })
    .join("")}</div>`;
}

function emptyState() {
  if (!ui.snap?.data.workspaces.length) {
    return `<div class="board empty-state"><strong>Aucun workspace pour l'instant</strong>Ouvrez un projet dans Paseo et lancez un agent : il apparaîtra ici.</div>`;
  }
  return `<div class="board empty-state"><strong>Aucune tâche ne correspond</strong>Modifiez la recherche ou les filtres d'état. <button type="button" class="link-btn" data-action="clear-filters">Tout afficher</button></div>`;
}

function renderTasksPage() {
  const all = visibleItems();
  const wsById = workspaceMap();
  const byState = (it) => !ui.filter.size || ui.filter.has(it.state);
  const searched = all.filter((it) => matchesQuery(it, wsById.get(it.workspaceId)));
  const filtered = searched.filter(byState);
  const scale = timeScale();

  let body;
  if (ui.view === "columns") {
    body = renderColumns(searched, wsById);
  } else {
    // Group by project, then workspace; urgent workspaces first.
    const lanesByWs = new Map();
    for (const ws of ui.snap?.data.workspaces ?? []) lanesByWs.set(ws.id, []);
    for (const it of filtered) {
      if (!lanesByWs.has(it.workspaceId)) continue;
      lanesByWs.get(it.workspaceId).push(it);
    }
    const q = ui.query.trim();
    const lanes = [];
    for (const ws of ui.snap?.data.workspaces ?? []) {
      const items = lanesByWs.get(ws.id) ?? [];
      const wsMatches = q && matchesQuery({ title: "" }, ws);
      if ((ui.filter.size || q) && items.length === 0 && !(wsMatches && !ui.filter.size)) continue;
      const status = wsStatusFor(ws, items);
      if (ui.hideQuiet && !ui.filter.size && !q && status === "done" && !items.some((i) => i.state === "todo")) continue;
      if (ws.synthetic && items.length === 0) continue;
      lanes.push({ ws, items, status });
    }
    const groups = new Map();
    for (const l of lanes) {
      const key = l.ws.projectId;
      if (!groups.has(key)) groups.set(key, { project: l.ws.project, lanes: [] });
      groups.get(key).lanes.push(l);
    }
    const rank = (l) => STATES[l.status].order;
    const sorted = [...groups.values()].map((g) => {
      g.lanes.sort((a, b) => rank(a) - rank(b) || (t(b.ws.lastActivityAt) ?? 0) - (t(a.ws.lastActivityAt) ?? 0));
      g.best = Math.min(...g.lanes.map(rank));
      return g;
    });
    sorted.sort((a, b) => a.best - b.best || a.project.localeCompare(b.project));
    body = renderLanes(sorted, scale);
  }

  return `${renderBanner()}${renderTriage(searched)}${renderToolbar(filtered.length, all.length)}${body}`;
}

// ---------------------------------------------------------------- drawer

function findItem(id) {
  const d = ui.snap?.data;
  if (!d) return null;
  return d.tasks.find((x) => x.id === id) ?? d.todos.find((x) => x.id === id) ?? null;
}

function renderDrawer() {
  const overlay = $("#overlay");
  const it = ui.selected ? findItem(ui.selected) : null;
  if (!it) {
    overlay.innerHTML = "";
    overlay.dataset.task = "";
    lastDrawerHtml = "";
    return;
  }
  const ws = workspaceMap().get(it.workspaceId);
  const now = nowMs();
  const facts = [];
  const add = (k, v) => v != null && v !== "" && facts.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`);
  add("Workspace", ws ? `${esc(ws.project)} / <strong>${esc(ws.name)}</strong>` : "—");
  if (ws?.branch) add("Branche", `<span class="mono">${esc(ws.branch)}</span>`);
  add("Agent", `${esc(providerName(it.provider))}${it.model ? ` <span class="mono">${esc(it.model)}</span>` : ""}`);
  let callout = "";
  if (it.state === "todo") {
    add("Prochaine exécution", `${esc(dateTimeFmt.format(t(it.nextRunAt)))} (${esc(relative(t(it.nextRunAt), now))})`);
    add("Fréquence", esc(it.cadence || "—"));
    if (it.lastRunAt) add("Dernière exécution", esc(relative(t(it.lastRunAt), now)));
  } else {
    if (it.mode) add("Mode", esc(it.mode));
    add("Créée", `${esc(dateTimeFmt.format(t(it.createdAt)))}`);
    if (it.turnStartedAt) add("Tour en cours depuis", esc(duration(now - t(it.turnStartedAt))));
    if (it.finishedAt) add("Terminée", esc(relative(t(it.finishedAt), now)));
    add("Durée", esc(duration(it.elapsedMs)));
    if (it.archivedAt) add("Archivée", esc(relative(t(it.archivedAt), now)));
    if (it.state === "needs_input")
      callout = `<div class="callout" data-state="needs_input"><strong>${it.pendingCount > 1 ? `${it.pendingCount} demandes en attente` : "Une demande attend votre réponse"}</strong>${esc(it.pendingSummary ?? "Ouvrez l'agent dans Paseo pour répondre.")}</div>`;
    if (it.state === "failed")
      callout = `<div class="callout" data-state="failed"><strong>L'agent s'est arrêté sur une erreur</strong>${esc(it.lastError ?? "Aucun détail fourni par le provider.")}</div>`;
    if (it.state === "review")
      callout = `<div class="callout" data-state="review"><strong>Terminé, à relire</strong>Le résultat n'a pas encore été consulté dans Paseo.</div>`;
  }
  let usage = "";
  if (it.usage && it.state !== "todo") {
    const u = it.usage;
    const ctx = u.contextUsed && u.contextMax ? u.contextUsed / u.contextMax : null;
    usage = `<h3>Consommation</h3><dl class="facts">
      <dt>Coût</dt><dd class="num">${esc(money(u.costUsd))}</dd>
      <dt>Tokens en entrée</dt><dd class="num">${esc(nf.format(u.inputTokens))}${u.cachedInputTokens ? ` <span class="cell-muted">dont ${esc(nfCompact.format(u.cachedInputTokens))} en cache</span>` : ""}</dd>
      <dt>Tokens en sortie</dt><dd class="num">${esc(nf.format(u.outputTokens))}</dd>
      ${
        ctx != null
          ? `<dt>Contexte</dt><dd><div class="meter" data-level="${ctx > 0.85 ? "danger" : ctx > 0.6 ? "warn" : ""}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ctx * 100)}"><span style="width:${Math.min(100, ctx * 100)}%"></span></div><span class="cell-muted num">${esc(pct.format(ctx))} de ${esc(nfCompact.format(u.contextMax))}</span></dd>`
          : ""
      }
    </dl>`;
  }
  const idLine =
    it.state === "todo"
      ? `<h3>Instruction planifiée</h3><pre class="prompt">${esc(it.prompt)}</pre>`
      : `<h3>Identifiant</h3><div class="copy-line"><code>${esc(it.id)}</code><button type="button" class="btn" data-copy="${esc(it.id)}">Copier</button></div>`;
  const html = `<div class="scrim" data-action="close"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-state="${it.state}">
      <header><div style="flex:1;min-width:0">${chip(it.state)}<h2 id="drawer-title">${esc(it.title)}</h2></div>
        <button type="button" class="icon-btn" data-action="close" aria-label="Fermer"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header>
      <div class="body">${callout}<dl class="facts">${facts.join("")}</dl>${usage}${idLine}</div>
    </aside>`;
  // Snapshots arrive every few seconds: only touch the DOM when content changed,
  // and only move focus when the drawer opens.
  if (html === lastDrawerHtml) return;
  const wasOpen = Boolean(lastDrawerHtml);
  const sameTask = overlay.dataset.task === it.id;
  lastDrawerHtml = html;
  overlay.dataset.task = it.id;
  overlay.innerHTML = html;
  if (wasOpen && sameTask) {
    $(".drawer", overlay).style.animation = "none";
  } else {
    $(".drawer [data-action=close]", overlay)?.focus({ preventScroll: true });
  }
}
let lastDrawerHtml = "";

// ---------------------------------------------------------------- metrics

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeMetrics() {
  const now = nowMs();
  const tasks = ui.snap?.data.tasks ?? [];
  const today = startOfDay(now);
  const days = Array.from({ length: 14 }, (_, i) => today - (13 - i) * DAY);
  const finished = tasks.filter((x) => ["done", "failed", "review"].includes(x.state) && t(x.finishedAt));
  const perDay = days.map((d) => {
    const inDay = finished.filter((x) => {
      const f = t(x.finishedAt);
      return f >= d && f < d + DAY;
    });
    return {
      day: d,
      ok: inDay.filter((x) => x.outcome !== "failed").length,
      failed: inDay.filter((x) => x.outcome === "failed").length,
    };
  });
  const in7 = (x, from, to) => {
    const f = t(x.finishedAt);
    return f >= from && f < to;
  };
  const cur = finished.filter((x) => in7(x, now - 7 * DAY, now + 1));
  const prev = finished.filter((x) => in7(x, now - 14 * DAY, now - 7 * DAY));
  const created7 = tasks.filter((x) => t(x.createdAt) >= now - 7 * DAY);
  const created7prev = tasks.filter((x) => t(x.createdAt) >= now - 14 * DAY && t(x.createdAt) < now - 7 * DAY);
  const successRate = (list) => (list.length ? list.filter((x) => x.outcome !== "failed").length / list.length : null);
  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
  const waiting = tasks.filter((x) => x.state === "needs_input" || x.state === "review");
  const oldestWait = waiting.reduce((m, x) => Math.min(m, t(x.attentionAt) ?? t(x.updatedAt) ?? now), now);

  // Heatmap: task starts by weekday × hour over 14 days.
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const x of tasks) {
    const c = t(x.createdAt);
    if (c < today - 13 * DAY) continue;
    const d = new Date(c);
    heat[(d.getDay() + 6) % 7][d.getHours()]++;
  }

  // Duration histogram for finished tasks over 14 days.
  const buckets = [
    { label: "< 5 min", max: 5 * MIN },
    { label: "5–15 min", max: 15 * MIN },
    { label: "15–30 min", max: 30 * MIN },
    { label: "30–60 min", max: HOUR },
    { label: "1–2 h", max: 2 * HOUR },
    { label: "> 2 h", max: Infinity },
  ].map((b) => ({ ...b, n: 0 }));
  const fin14 = finished.filter((x) => t(x.finishedAt) >= today - 13 * DAY && x.elapsedMs != null);
  for (const x of fin14) buckets.find((b) => x.elapsedMs < b.max).n++;

  const group = (list, keyFn) => {
    const m = new Map();
    for (const x of list) {
      const k = keyFn(x);
      const g = m.get(k) ?? { key: k, n: 0, cost: 0, tokens: 0 };
      g.n++;
      g.cost += x.usage?.costUsd ?? 0;
      g.tokens += (x.usage?.inputTokens ?? 0) + (x.usage?.outputTokens ?? 0);
      m.set(k, g);
    }
    return [...m.values()];
  };
  const recent = tasks.filter((x) => t(x.createdAt) >= today - 13 * DAY);
  const wsById = workspaceMap();
  const byProvider = group(recent, (x) => x.provider ?? "—");
  const byWorkspace = group(recent, (x) => x.workspaceId).map((g) => {
    const ws = wsById.get(g.key);
    return { ...g, label: ws ? `${ws.project} / ${ws.name}` : "Sans workspace" };
  });

  return {
    now,
    perDay,
    finished7: cur.length,
    finishedPrev: prev.length,
    successRate: successRate(cur),
    successPrev: successRate(prev),
    medianDuration: median(cur.map((x) => x.elapsedMs).filter((v) => v != null)),
    medianPrev: median(prev.map((x) => x.elapsedMs).filter((v) => v != null)),
    cost7: sum(created7, (x) => x.usage?.costUsd ?? 0),
    costPrev: sum(created7prev, (x) => x.usage?.costUsd ?? 0),
    tokens7: sum(created7, (x) => (x.usage?.inputTokens ?? 0) + (x.usage?.outputTokens ?? 0)),
    tokensPrev: sum(created7prev, (x) => (x.usage?.inputTokens ?? 0) + (x.usage?.outputTokens ?? 0)),
    waiting: waiting.sort((a, b) => (t(a.attentionAt) ?? 0) - (t(b.attentionAt) ?? 0)),
    oldestWait: waiting.length ? now - oldestWait : null,
    running: tasks.filter((x) => x.state === "running").length,
    heat,
    buckets,
    byProvider,
    byWorkspace,
  };
}

function delta(cur, prev, { goodWhenUp = true, format = (v) => nf.format(v), unit = "" } = {}) {
  if (prev == null || cur == null) return `<div class="k-delta">pas de période de comparaison</div>`;
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return `<div class="k-delta">stable vs 7 j précédents</div>`;
  const up = diff > 0;
  const good = up === goodWhenUp;
  return `<div class="k-delta"><span class="${good ? "up" : "down"}">${up ? "▲" : "▼"} ${esc(format(Math.abs(diff)))}${unit}</span> vs 7 j précédents</div>`;
}

function sparkline(values, width = 220, height = 34) {
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 8)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--line-strong)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <path d="${pts.slice(-7).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="var(--st-running)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="var(--st-running)" stroke="var(--surface)" stroke-width="2"/>
  </svg>`;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function roundedTop(x, y, w, h, r) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`;
}

/** Stacked column chart. series: [{key, label, state, color, values}] */
function columnChart({ categories, series, height = 220, tipTitle }) {
  const W = 640;
  const pad = { l: 34, r: 8, t: 10, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const totals = categories.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
  const max = niceMax(Math.max(...totals));
  const band = innerW / categories.length;
  const bw = Math.min(24, band * 0.62);
  const y = (v) => pad.t + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  let svg = `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(tipTitle)}">`;
  for (const tk of ticks) {
    svg += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(tk)}" y2="${y(tk)}"/>`;
    svg += `<text x="${pad.l - 8}" y="${y(tk) + 3.5}" text-anchor="end">${nf.format(tk)}</text>`;
  }
  categories.forEach((c, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - bw / 2;
    const tip = `<strong>${esc(c.long)}</strong>${series
      .map((s) => `<div class="t-row"><span>${esc(s.label)}</span><span>${nf.format(s.values[i])}</span></div>`)
      .join("")}`;
    svg += `<g class="col-group" data-tip="${esc(tip)}"><rect class="hover-band" x="${pad.l + band * i + 1}" y="${pad.t}" width="${band - 2}" height="${innerH}" rx="4"/>`;
    let acc = 0;
    const visible = series.filter((s) => s.values[i] > 0);
    series.forEach((s) => {
      const v = s.values[i];
      if (!v) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      const isTop = s === visible[visible.length - 1];
      const h = y0 - y1 - (acc > 0 ? 2 : 0);
      svg += isTop
        ? `<path d="${roundedTop(x, y1, bw, h, 4)}" fill="${s.color}"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(0, h)}" fill="${s.color}"/>`;
      acc += v;
    });
    if (c.short) svg += `<text x="${cx}" y="${height - 8}" text-anchor="middle">${esc(c.short)}</text>`;
    svg += `<rect class="hit" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${innerH + pad.b}"/></g>`;
  });
  svg += `<line class="axis-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
  return svg;
}

function hbars(rows, { value, format, color = "var(--seq-4)", label = (r) => r.label }) {
  const max = Math.max(...rows.map(value), 0) || 1;
  return `<div class="hbars">${rows
    .map(
      (r) => `<div class="hbar" data-tip="${esc(`<strong>${esc(label(r))}</strong><div class="t-row"><span>Tâches</span><span>${nf.format(r.n)}</span></div><div class="t-row"><span>Coût</span><span>${esc(money(r.cost))}</span></div><div class="t-row"><span>Tokens</span><span>${esc(nfCompact.format(r.tokens))}</span></div>`)}">
        <span class="name" title="${esc(label(r))}">${esc(label(r))}</span>
        <span class="bar"><span style="width:${(value(r) / max) * 100}%;background:${color}"></span></span>
        <span class="val">${esc(format(value(r)))}</span></div>`,
    )
    .join("")}</div>`;
}

function dataTable(head, rows) {
  return `<details class="data"><summary>Voir les données</summary><table class="t"><thead><tr>${head
    .map((h, i) => `<th${i ? ' class="r"' : ""}>${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="r"' : ""}>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></details>`;
}

function renderMetricsPage() {
  const m = computeMetrics();
  const now = m.now;
  const dayCats = m.perDay.map((d, i) => ({
    long: new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(d.day),
    short: i % 2 === 1 || i === 13 ? dayFmt.format(d.day) : "",
  }));
  const pctFmt = (v) => (v == null ? "—" : pct.format(v));
  const kpis = `<div class="kpis" data-testid="kpis">
    <div class="kpi hero"><div class="k-label">Tâches terminées sur 7 jours</div>
      <div class="k-value num" data-testid="kpi-finished">${nf.format(m.finished7)}</div>
      ${delta(m.finished7, m.finishedPrev)}
      ${sparkline(m.perDay.map((d) => d.ok + d.failed))}</div>
    <div class="kpi"><div class="k-label">Taux de réussite</div><div class="k-value num" data-testid="kpi-success">${pctFmt(m.successRate)}</div>
      ${m.successRate != null && m.successPrev != null ? delta(Math.round(m.successRate * 100), Math.round(m.successPrev * 100), { unit: " pts" }) : delta(null, null)}</div>
    <div class="kpi"><div class="k-label">Durée médiane d'une tâche</div><div class="k-value num">${esc(duration(m.medianDuration))}</div>
      ${m.medianDuration != null && m.medianPrev != null ? delta(m.medianDuration, m.medianPrev, { goodWhenUp: false, format: duration }) : delta(null, null)}</div>
    <div class="kpi"><div class="k-label">Coût sur 7 jours</div><div class="k-value num" data-testid="kpi-cost">${esc(money(m.cost7))}</div>
      ${delta(m.cost7, m.costPrev, { goodWhenUp: false, format: money })}</div>
    <div class="kpi"><div class="k-label">Tokens sur 7 jours</div><div class="k-value num">${esc(nfCompact.format(m.tokens7))}</div>
      ${delta(m.tokens7, m.tokensPrev, { goodWhenUp: false, format: (v) => nfCompact.format(v) })}</div>
    <div class="kpi"><div class="k-label">Attendent votre retour</div><div class="k-value num" data-testid="kpi-waiting">${nf.format(m.waiting.length)}</div>
      <div class="k-delta">${m.oldestWait != null ? `la plus ancienne depuis ${esc(duration(m.oldestWait))}` : "rien en attente"}</div></div>
  </div>`;

  const perDayChart = columnChart({
    tipTitle: "Tâches terminées par jour",
    categories: dayCats,
    series: [
      { label: "Réussies", color: "var(--st-done)", values: m.perDay.map((d) => d.ok) },
      { label: "En erreur", color: "var(--st-failed)", values: m.perDay.map((d) => d.failed) },
    ],
  });

  const waitList = m.waiting.length
    ? `<ul class="waitlist">${m.waiting
        .slice(0, 8)
        .map((x) => {
          const ws = workspaceMap().get(x.workspaceId);
          return `<li><button type="button" data-task="${esc(x.id)}" data-state="${x.state}">${stateIcon(x.state)}<span><strong>${esc(x.title)}</strong><small>${esc(ws ? ws.name : "")} · ${esc(STATES[x.state].label)}</small></span><small class="num">${esc(duration(now - (t(x.attentionAt) ?? t(x.updatedAt))))}</small></button></li>`;
        })
        .join("")}</ul>`
    : `<p class="cell-muted">Rien ne vous attend. Les agents travaillent seuls.</p>`;

  const heatMax = Math.max(1, ...m.heat.flat());
  const seq = (v) => (v === 0 ? "var(--seq-0)" : `var(--seq-${Math.min(6, 1 + Math.floor((v / heatMax) * 5.999))})`);
  const dayNames = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
  const heat = `<div class="heat" role="img" aria-label="Démarrages de tâches par jour de semaine et par heure">
    <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hl">${h % 3 === 0 ? h : ""}</span>`).join("")}
    ${m.heat
      .map(
        (row, d) =>
          `<span class="dl">${dayNames[d]}</span>${row
            .map(
              (v, h) =>
                `<span class="cell" style="background:${seq(v)}" data-tip="${esc(`<strong>${dayNames[d]} ${h} h – ${h + 1} h</strong>${v} tâche${v > 1 ? "s" : ""} démarrée${v > 1 ? "s" : ""}`)}"></span>`,
            )
            .join("")}`,
      )
      .join("")}
  </div>
  <div class="heat-scale">Moins ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<i style="background:var(--seq-${i})"></i>`).join("")} Plus</div>`;

  const histo = columnChart({
    tipTitle: "Répartition des durées",
    height: 200,
    categories: m.buckets.map((b) => ({ long: b.label, short: b.label })),
    series: [{ label: "Tâches", color: "var(--seq-4)", values: m.buckets.map((b) => b.n) }],
  });

  const prov = m.byProvider.sort((a, b) => b.n - a.n);
  const provCost = m.byProvider.slice().sort((a, b) => b.cost - a.cost);
  const wsCost = m.byWorkspace.sort((a, b) => b.cost - a.cost).slice(0, 8);

  return `${renderBanner()}
  <div class="m-head"><div><h1>Métriques</h1><p>Activité de vos agents sur les 14 derniers jours, tous workspaces confondus.</p></div>
    <span class="cell-muted">${m.running} agent${m.running > 1 ? "s" : ""} au travail en ce moment</span></div>
  ${kpis}
  <div class="m-grid">
    <section class="panel span-8" data-testid="chart-per-day"><h2>Tâches terminées par jour</h2><p class="sub">14 derniers jours</p>
      <div class="legend"><span data-state="done"><i></i>Réussies</span><span data-state="failed"><i></i>En erreur</span></div>
      <div class="chart">${perDayChart}</div>
      ${dataTable(["Jour", "Réussies", "En erreur"], m.perDay.map((d, i) => [dayCats[i].long, d.ok, d.failed]))}</section>
    <section class="panel span-4" data-testid="waiting"><h2>Attendent votre retour</h2><p class="sub">Les plus anciennes d'abord</p>${waitList}</section>
    <section class="panel span-6"><h2>Quand vos agents travaillent</h2><p class="sub">Tâches démarrées par jour et par heure, 14 derniers jours</p>${heat}</section>
    <section class="panel span-6"><h2>Durée des tâches</h2><p class="sub">Du lancement à la fin, tâches terminées sur 14 jours</p>
      <div class="chart">${histo}</div>${dataTable(["Durée", "Tâches"], m.buckets.map((b) => [b.label, b.n]))}</section>
    <section class="panel span-4"><h2>Tâches par agent</h2><p class="sub">Lancées sur 14 jours</p>
      ${hbars(prov, { value: (r) => r.n, format: (v) => nf.format(v), label: (r) => providerName(r.key) })}</section>
    <section class="panel span-4"><h2>Coût par agent</h2><p class="sub">Tâches lancées sur 14 jours</p>
      ${hbars(provCost, { value: (r) => r.cost, format: money, label: (r) => providerName(r.key) })}
      ${dataTable(["Agent", "Tâches", "Coût", "Tokens"], provCost.map((r) => [providerName(r.key), r.n, money(r.cost), nfCompact.format(r.tokens)]))}</section>
    <section class="panel span-4"><h2>Coût par workspace</h2><p class="sub">Les 8 plus coûteux, 14 jours</p>
      ${hbars(wsCost, { value: (r) => r.cost, format: money })}
      ${dataTable(["Workspace", "Tâches", "Coût"], wsCost.map((r) => [r.label, r.n, money(r.cost)]))}</section>
  </div>`;
}

// ---------------------------------------------------------------- render loop

function render() {
  const app = $("#app");
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.route === ui.route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  renderConn();
  if (!ui.snap) {
    app.innerHTML = `<div class="board empty-state"><strong>Connexion au daemon…</strong>Les tâches apparaîtront dès la première réponse.</div>`;
    return;
  }
  // Keep focus and caret in the search box across re-renders.
  const active = document.activeElement;
  const searchFocused = active?.id === "q";
  const caret = searchFocused ? active.selectionStart : null;
  const scrollY = window.scrollY;
  app.innerHTML = ui.route === "metrics" ? renderMetricsPage() : renderTasksPage();
  if (searchFocused) {
    const q = $("#q");
    q?.focus({ preventScroll: true });
    q?.setSelectionRange(caret, caret);
  }
  window.scrollTo(0, scrollY);
  renderDrawer();
  document.title =
    ui.route === "metrics" ? "Métriques · Paseo" : `${attentionCount() ? `(${attentionCount()}) ` : ""}Tâches · Paseo`;
}

function attentionCount() {
  return (ui.snap?.data.tasks ?? []).filter((x) => x.state === "needs_input").length;
}

// ---------------------------------------------------------------- events

function closeDrawer() {
  const last = ui.selected;
  ui.selected = null;
  renderDrawer();
  if (last) document.querySelector(`[data-task="${CSS.escape(last)}"]`)?.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("button, a, [data-action]");
  if (!el) return;
  if (el.dataset.filter) {
    const k = el.dataset.filter;
    if (ui.filter.has(k)) ui.filter.delete(k);
    else ui.filter.add(k);
    return render();
  }
  if (el.dataset.view) {
    ui.view = el.dataset.view;
    store.set("view", ui.view);
    return render();
  }
  if (el.dataset.window) {
    ui.window = el.dataset.window;
    store.set("window", ui.window);
    return render();
  }
  if (el.dataset.toggle) {
    const lane = el.closest(".lane");
    const open = lane.dataset.open !== "true";
    ui.openOverrides.set(el.dataset.toggle, open);
    store.set("open", Object.fromEntries(ui.openOverrides));
    return render();
  }
  if (el.dataset.more) {
    ui.expandedLists.add(el.dataset.more);
    return render();
  }
  if (el.dataset.task) {
    ui.selected = el.dataset.task;
    hideTip();
    return renderDrawer();
  }
  if (el.dataset.copy) {
    navigator.clipboard?.writeText(el.dataset.copy).then(
      () => {
        el.textContent = "Copié";
        setTimeout(() => (el.textContent = "Copier"), 1500);
      },
      () => {},
    );
    return;
  }
  if (el.dataset.action === "close") return closeDrawer();
  if (el.dataset.action === "clear-filters") {
    ui.filter.clear();
    ui.query = "";
    return render();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "q") {
    ui.query = e.target.value;
    render();
  }
  if (e.target.id === "hideQuiet") {
    ui.hideQuiet = e.target.checked;
    store.set("hideQuiet", ui.hideQuiet);
    render();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.selected) closeDrawer();
  if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && ui.route === "tasks") {
    e.preventDefault();
    $("#q")?.focus();
  }
});

// Tooltip: any element with data-tip (HTML built by us, already escaped).
const tip = $("#tooltip");
function hideTip() {
  tip.hidden = true;
}
function showTip(target, x, y) {
  tip.innerHTML = target.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = y + r.height + 24 > window.innerHeight ? y - r.height - 12 : y + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
document.addEventListener("pointermove", (e) => {
  const target = e.target.closest?.("[data-tip]");
  if (!target) return hideTip();
  showTip(target, e.clientX, e.clientY);
});
document.addEventListener("focusin", (e) => {
  const target = e.target.closest?.("[data-tip]");
  if (!target) return hideTip();
  const r = target.getBoundingClientRect();
  showTip(target, r.left + r.width / 2, r.bottom);
});
document.addEventListener("scroll", hideTip, { passive: true });

// Theme toggle: light ⇄ dark, stored per browser.
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get("theme", null));
$("#theme").addEventListener("click", () => {
  const current =
    document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  store.set("theme", next);
});

function routeFromHash() {
  ui.route = location.hash.startsWith("#/metriques") ? "metrics" : "tasks";
  render();
}
window.addEventListener("hashchange", routeFromHash);

// Live data: SSE, with a polling fallback.
function connect() {
  let es;
  try {
    es = new EventSource("api/events");
  } catch {
    return poll();
  }
  es.addEventListener("state", (e) => {
    ui.snap = JSON.parse(e.data);
    render();
  });
  es.onerror = () => {
    if (ui.snap) {
      ui.snap = { ...ui.snap, connection: { ...ui.snap.connection, status: "error", error: "Serveur du tableau de bord injoignable" } };
      renderConn();
    }
  };
}
async function poll() {
  try {
    const r = await fetch("api/state");
    ui.snap = await r.json();
    render();
  } catch {}
  setTimeout(poll, 5000);
}

window.__paseoDashboard = ui; // handy for debugging from the console
routeFromHash();
connect();
