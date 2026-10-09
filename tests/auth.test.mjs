// HTTP Basic auth: 401 without or with wrong credentials, 200 with the right ones,
// and the server refuses to leave loopback without --auth.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.mjs";

const basic = (s) => ({ authorization: `Basic ${Buffer.from(s).toString("base64")}` });

test("requests need the configured user:password", async () => {
  const server = await startServer(["--demo", "--frozen", "--auth", "paul:s3cret"]);
  try {
    const anon = await fetch(`${server.url}/api/state`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get("www-authenticate"), /^Basic /);
    assert.equal((await fetch(`${server.url}/api/state`, { headers: basic("paul:wrong") })).status, 401);
    assert.equal((await fetch(`${server.url}/api/state`, { headers: basic("paul:s3cret") })).status, 200);
    assert.equal((await fetch(`${server.url}/`, { headers: basic("paul:s3cret") })).status, 200);
  } finally {
    await server.stop();
  }
});

test("without --auth the server only listens on loopback", async () => {
  await assert.rejects(startServer(["--demo", "--frozen", "--host", "0.0.0.0"]), /sans --auth/);
});
