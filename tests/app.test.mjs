import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../dist/app.js";

const prefix = "[builder-connector-local]";

async function receiver(t, flag) {
  const server = createApp(flag, prefix).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const payload = (...messages) => ({ body: { value: messages } });
const post = (url, body) => fetch(`${url}/api/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("flags only matching message IDs and returns counts", async t => {
  const calls = [];
  const url = await receiver(t, async id => { calls.push(id); });
  const response = await post(url, payload(
    { id: "matching", subject: `${prefix} validation` },
    { id: "control", subject: "nonmatching control" },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: 2, flagged: 1 });
  assert.deepEqual(calls, ["matching"]);
});

test("accepts an authentication-only empty batch without calling the connector", async t => {
  const url = await receiver(t, async () => { assert.fail("Unexpected connector call"); });
  const response = await post(url, payload());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: 0, flagged: 0 });
});

test("validates the complete batch before any flag operation", async t => {
  const calls = [];
  const url = await receiver(t, async id => { calls.push(id); });
  for (const body of [
    null, {}, { value: [] }, payload({ id: " ", subject: prefix }),
    payload({ id: "first", subject: prefix }, { id: "invalid" }),
    payload(...Array.from({ length: 101 }, () => ({ id: "id", subject: prefix }))),
  ]) {
    const response = await post(url, body);
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  assert.deepEqual(calls, []);
});

test("rejects malformed JSON and oversized input without effects", async t => {
  const calls = [];
  const url = await receiver(t, async id => { calls.push(id); });
  for (const [body, expected] of [["{", 400], [JSON.stringify({ data: "x".repeat(1024 * 1024) }), 413]]) {
    const response = await fetch(`${url}/api/webhook`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  assert.deepEqual(calls, []);
});

test("does not acknowledge a failed action or expose SDK details", async t => {
  const url = await receiver(t, async () => { throw new Error("sensitive SDK detail"); });
  const response = await post(url, payload({ id: "id", subject: prefix }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Flag operation failed" });
});

test("duplicate delivery repeats the same idempotent flag operation", async t => {
  const calls = [];
  const url = await receiver(t, async id => { calls.push(id); });
  for (let count = 0; count < 2; count++) {
    const response = await post(url, payload({ id: "same-id", subject: prefix }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: 1, flagged: 1 });
  }
  assert.deepEqual(calls, ["same-id", "same-id"]);
});

test("health does not call the SDK", async t => {
  const url = await receiver(t, async () => { assert.fail("Unexpected mailbox call"); });
  const response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "healthy" });
});

test("requires a bounded, deliberate test prefix", () => {
  for (const value of ["", " ", "email", "[builder-connector-]"]) {
    assert.throws(() => createApp(async () => {}, value), /TEST_SUBJECT_PREFIX/);
  }
});
