// Stand-in for @getpaseo/client used by the e2e suite. It mirrors the SDK
// surface the dashboard touches (DaemonClient + createPaseoApi) and serves
// payloads shaped like the daemon's wire schemas. State is read from the JSON
// file in PASEO_FAKE_STATE on every call so tests can change it live; every
// call is appended to PASEO_FAKE_LOG so tests can assert what was requested.

import { readFileSync, appendFileSync } from "node:fs";

function state() {
  return JSON.parse(readFileSync(process.env.PASEO_FAKE_STATE, "utf8"));
}

function log(entry) {
  if (process.env.PASEO_FAKE_LOG) appendFileSync(process.env.PASEO_FAKE_LOG, `${JSON.stringify(entry)}\n`);
}

function paginate(all, options) {
  const limit = state().pageSize ?? options?.page?.limit ?? 200;
  const start = options?.page?.cursor ? Number(options.page.cursor) : 0;
  const entries = all.slice(start, start + limit);
  const next = start + limit < all.length ? String(start + limit) : null;
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    entries,
    pageInfo: { nextCursor: next, prevCursor: null, hasMore: next !== null },
  };
}

export class DaemonClient {
  constructor(config) {
    this.config = config;
    this.status = "idle";
    log({ call: "new DaemonClient", url: config.url, clientType: config.clientType, hasPassword: Boolean(config.password) });
  }
  async connect() {
    log({ call: "connect" });
    if (state().down) {
      this.status = "disconnected";
      throw new Error("connect ECONNREFUSED 127.0.0.1:6767");
    }
    this.status = "connected";
  }
  getConnectionState() {
    if (state().down) this.status = "disconnected";
    return { status: this.status };
  }
  async close() {
    this.status = "disposed";
    log({ call: "close" });
  }
  async scheduleList() {
    log({ call: "scheduleList" });
    if (state().down) throw new Error("socket closed");
    return { requestId: "r", schedules: state().schedules ?? [], error: null };
  }
}

export function createPaseoApi(daemon) {
  const guard = () => {
    if (daemon.status !== "connected" || state().down) throw new Error("Not connected to daemon");
  };
  return {
    workspaces: {
      async list(options) {
        log({ call: "workspaces.list", options });
        guard();
        return paginate(state().workspaces ?? [], options);
      },
    },
    agents: {
      async list(options) {
        log({ call: "agents.list", options });
        guard();
        let entries = state().agentEntries ?? [];
        if (!options?.filter?.includeArchived) entries = entries.filter((e) => !e.agent.archivedAt);
        return paginate(entries, options);
      },
    },
    async dispose() {},
  };
}
