import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { UID, GID } from "./helpers.js";

const config = loadConfig({ ORBIT_SIGNING_KEY: "k".repeat(40), ORBIT_SITE_SECRET: "s".repeat(40), ALLOWED_ORIGINS: "https://portal.example" });
const auth = { authorization: "Bearer " + "s".repeat(40) };

test("secret endpoints require the site secret", async () => {
  const app = await buildServer(config);
  const body = { userId: UID, guildId: GID, difficulty: "high" };
  assert.equal((await app.inject({ method: "POST", url: "/v1/session", payload: body })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/v1/session", payload: body, headers: { authorization: "Bearer wrong" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/v1/siteverify", payload: { token: "x" } })).statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/v1/session", payload: body, headers: auth });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().session);
});

test("widget can start a challenge from a session; client can't pick difficulty", async () => {
  const app = await buildServer(config);
  const s = (await app.inject({ method: "POST", url: "/v1/session", payload: { userId: UID, guildId: GID, difficulty: "extreme" }, headers: auth })).json();
  const c = (await app.inject({ method: "POST", url: "/v1/challenge/new", payload: { session: s.session, difficulty: "medium" } })).json();
  assert.equal(c.ok, true);
  assert.equal(c.rounds, 3);
  assert.equal(c.scene.objects.length, 14);
});

test("answer failures return only a coarse reason", async () => {
  const app = await buildServer(config);
  const r = await app.inject({ method: "POST", url: "/v1/challenge/answer", payload: { token: "bad.token", answer: {} } });
  assert.deepEqual(r.json(), { ok: false, reason: "invalid" });
});

test("frame is served with a locked-down CSP limited to allowed origins", async () => {
  const app = await buildServer(config);
  const r = await app.inject("/widget/frame");
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["content-security-policy"], /frame-ancestors https:\/\/portal\.example/);
  assert.match(r.headers["content-security-policy"], /script-src 'self'/);
  assert.match(r.headers["content-security-policy"], /object-src 'none'/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(r.headers["cross-origin-resource-policy"], "cross-origin");
  assert.match(r.headers["permissions-policy"], /camera=\(\)/);
});

test("rate limit kicks in for the browser endpoints", async () => {
  const app = await buildServer(config);
  let limited = false;
  for (let i = 0; i < 60; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/challenge/new", payload: { session: "x" } });
    if (r.statusCode === 429) { limited = true; break; }
  }
  assert.ok(limited);
});

test("repeated attempts with one challenge token hit the token limiter", async () => {
  const app = await buildServer(config);
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/challenge/answer", payload: { token: "same-token", answer: {} } });
    if (r.statusCode === 429) { limited = true; break; }
  }
  assert.ok(limited);
});

test("production refuses to start without strong secrets", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }));
});
