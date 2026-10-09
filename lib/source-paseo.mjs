// Reads workspaces, agents and schedules from a Paseo daemon through the
// official TypeScript SDK (@getpaseo/client), polling on an interval.

const PAGE_LIMIT = 200;
const MAX_PAGES = 25;

async function loadSdk() {
  // PASEO_SDK_MODULE lets the test suite swap in a contract-shaped fake.
  const override = process.env.PASEO_SDK_MODULE;
  if (override) {
    const mod = await import(override);
    return { createPaseoApi: mod.createPaseoApi, DaemonClient: mod.DaemonClient };
  }
  const [main, internal] = await Promise.all([
    import("@getpaseo/client"),
    import("@getpaseo/client/internal/daemon-client"),
  ]);
  return { createPaseoApi: main.createPaseoApi, DaemonClient: internal.DaemonClient };
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Délai dépassé (${what}, ${ms} ms)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function collectPages(fetchPage) {
  const entries = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPage(cursor);
    entries.push(...(page.entries ?? []));
    if (!page.pageInfo?.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return entries;
}

export function createPaseoSource({ url, password, logger = console }) {
  let daemon = null;
  let api = null;
  let connecting = null;

  async function connect() {
    if (api) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const { createPaseoApi, DaemonClient } = await loadSdk();
      daemon = new DaemonClient({
        url,
        clientId: `paseo-dashboard-${process.pid}`,
        clientType: "cli",
        appVersion: "paseo-dashboard/1.0.0",
        ...(password ? { password } : {}),
        // The poll loop reconnects on its own; keep the SDK from retrying forever.
        reconnect: { enabled: false },
        connectTimeoutMs: 5000,
        suppressSendErrors: true,
      });
      api = createPaseoApi(daemon);
      await withTimeout(daemon.connect(), 8000, "connexion au daemon");
    })();
    try {
      await connecting;
    } catch (error) {
      await close();
      throw error;
    } finally {
      connecting = null;
    }
  }

  async function close() {
    const d = daemon;
    const a = api;
    daemon = null;
    api = null;
    try {
      await a?.dispose();
    } catch {}
    try {
      await d?.close();
    } catch {}
  }

  async function fetchRaw() {
    if (daemon && daemon.getConnectionState?.().status !== "connected") await close();
    await connect();
    const [workspaces, agentEntries, schedules] = await Promise.all([
      collectPages((cursor) =>
        api.workspaces.list({
          sort: [{ key: "status_priority", direction: "asc" }],
          page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        }),
      ),
      collectPages((cursor) =>
        api.agents.list({
          filter: { includeArchived: true },
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        }),
      ),
      // Schedules are not on the public SDK surface yet; read them from the
      // underlying client and degrade to "no schedules" if that changes.
      typeof daemon.scheduleList === "function"
        ? daemon
            .scheduleList()
            .then((r) => r?.schedules ?? [])
            .catch((error) => {
              logger.warn?.(`[paseo] schedules unavailable: ${error.message}`);
              return [];
            })
        : Promise.resolve([]),
    ]);
    return { workspaces, agentEntries, schedules };
  }

  return {
    kind: "paseo",
    label: url,
    async fetch() {
      try {
        return await withTimeout(fetchRaw(), 20000, "lecture du daemon");
      } catch (error) {
        // Drop the connection so the next poll starts clean.
        await close();
        throw error;
      }
    },
    close,
  };
}
