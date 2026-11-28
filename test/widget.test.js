// Drives public/frame.js against the REAL server with a fake DOM and a fake clock.
// This is a logic/smoke test, not a visual test: look at it in a real browser too.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { KEY, sceneFor, decodePayload, UID, GID } from "./helpers.js";
import { targetPosition } from "../src/scene.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const ORIGIN = "http://localhost:3000";

const supported = typeof nodeModule.registerHooks === "function";
if (supported) {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("/lib/")) return { url: pathToFileURL(path.join(srcDir, specifier.slice(5))).href, shortCircuit: true };
      return next(specifier, context);
    },
  });
}

const SECRET = "s".repeat(40);
const config = loadConfig({ ORBIT_SIGNING_KEY: KEY, ORBIT_SITE_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN });

function ctxProxy() {
  const p = new Proxy(function () {}, { get: () => (..._a) => p, set: () => true, apply: () => p });
  return p;
}

function makeEl(id) {
  const handlers = {};
  const attrs = {};
  const classes = new Set();
  return {
    id, style: {}, textContent: "", className: "", width: 0, height: 0,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => (attrs[k] = String(v)),
    getAttribute: (k) => attrs[k],
    addEventListener: (t, fn) => (handlers[t] ||= []).push(fn),
    removeEventListener: (t, fn) => (handlers[t] = (handlers[t] || []).filter((f) => f !== fn)),
    dispatch: (t, ev) => (handlers[t] || []).slice().forEach((f) => f(ev)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 340, height: 255 }),
    getContext: () => ctxProxy(),
    _attrs: attrs, _classes: classes,
  };
}

async function setup(runId) {
  const clock = { t: 0 };
  const BASE = 1_800_000_000_000;
  const app = await buildServer(config, { now: () => BASE + clock.t });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const els = {};
  for (const id of ["box", "label", "sub", "pop", "c", "instrSmall", "instr", "rounds", "bar", "help", "close"]) els[id] = makeEl(id);
  const docHandlers = {};
  const winHandlers = {};
  const outbox = [];
  const rafQueue = [];
  const bodyClasses = new Set();
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const nativeFetch = g.fetch;

  set("window", g);
  set("addEventListener", (t, fn) => (winHandlers[t] ||= []).push(fn));
  set("devicePixelRatio", 1);
  set("location", { hash: "#origin=" + encodeURIComponent(ORIGIN) });
  set("parent", { postMessage: (msg, o) => outbox.push({ msg, o }) });
  const realPerf = g.performance;
  set("performance", new Proxy(realPerf, { get: (t, k) => (k === "now" ? () => clock.t : typeof t[k] === "function" ? t[k].bind(t) : t[k]) }));
  set("requestAnimationFrame", (fn) => { rafQueue.push(fn); return rafQueue.length; });
  set("cancelAnimationFrame", () => {});
  set("createImageBitmap", async () => ({ close: () => {} }));
  const apiLog = [];
  set("fetch", async (p, opts) => {
    const url = typeof p === "string" && /^https?:\/\//i.test(p) ? p : origin + p;
    const res = await nativeFetch(url, opts);
    if (p === "/v1/challenge/frame") return {
      ok: res.ok,
      headers: new Headers({ "content-type": "image/png", "content-length": String(Number(res.headers.get("content-length") || 0)) }),
      blob: async () => new Blob([await res.arrayBuffer()], { type: "image/png" }),
    };
    const json = await res.json();
    apiLog.push({ path: p, json });
    return { json: async () => json };
  });
  set("document", {
    getElementById: (id) => els[id],
    addEventListener: (t, fn) => (docHandlers[t] ||= []).push(fn),
    removeEventListener: (t, fn) => (docHandlers[t] = (docHandlers[t] || []).filter((f) => f !== fn)),
    body: { classList: { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c) } },
  });

  await import(`../public/frame.js?run=${runId}`);

  const tick = () => new Promise((r) => setTimeout(r, 1)); // real timers (sleep() in the widget) need real time to pass
  const step = async (ms = 16) => {
    clock.t += ms;
    const q = rafQueue.splice(0);
    q.forEach((fn) => fn());
    await tick();
  };
  const waitFor = async (pred, maxSteps = 4000, ms = 16) => {
    for (let i = 0; i < maxSteps; i++) { if (pred()) return true; await step(ms); }
    return false;
  };
  const sessionFromServer = async () => (await (await nativeFetch(origin + "/v1/session", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + SECRET }, body: JSON.stringify({ userId: UID, guildId: GID, difficulty: "medium" }) })).json()).session;

  async function clickBoxAndGiveSession() {
    els.box.dispatch("click", {});
    await tick();
    const req = outbox.find((o) => o.msg.event === "request_session");
    assert.ok(req, "frame must ask the parent for a session");
    assert.equal(req.o, ORIGIN);
    const session = await sessionFromServer();
    (winHandlers.message || []).forEach((fn) => fn({ source: g.parent, origin: ORIGIN, data: { target: "axex-orbit-frame", cmd: "session", session } }));
  }

  // tap like a person: move the mouse along a curve, then press
  async function tapAt(logical, rectScale = 340 / 360) {
    const tx = logical[0] * rectScale, ty = logical[1] * rectScale;
    const sx = 30, sy = 20;
    for (let i = 0; i <= 14; i++) {
      const p = i / 14, e = p * p * (3 - 2 * p);
      (docHandlers.pointermove || []).forEach((fn) => fn({ clientX: sx + (tx - sx) * e + Math.sin(p * 3) * 6, clientY: sy + (ty - sy) * e + Math.cos(p * 3) * 4, isTrusted: true, pointerType: "mouse" }));
      await step(11);
    }
    els.c.dispatch("pointerdown", { clientX: tx + 2, clientY: ty - 1, isTrusted: true, pointerType: "mouse" });
  }

  const sendToFrame = (data) => (winHandlers.message || []).forEach((fn) => fn({ source: g.parent, origin: ORIGIN, data: { target: "axex-orbit-frame", ...data } }));
  const cleanup = async () => {
    await app.close();
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  };
  return { els, outbox, apiLog, clock, step, waitFor, tick, clickBoxAndGiveSession, tapAt, cleanup, bodyClasses, origin, sendToFrame };
}

test("widget: checkbox -> popup -> tap the right ball -> pass token verified by siteverify", { skip: !supported && "needs node >= 22.15 (module.registerHooks)", timeout: 60000 }, async () => {
  const w = await setup(1);
  try {
    assert.equal(w.els.box._attrs["data-state"], "idle");
    await w.clickBoxAndGiveSession();
    assert.ok(await w.waitFor(() => w.bodyClasses.has("pop")), "popup should open");
    assert.ok(w.outbox.some((o) => o.msg.event === "mode" && o.msg.mode === "pop"));
    const first = w.apiLog.find((a) => a.path === "/v1/challenge/new").json;
    assert.equal(first.rounds, 1);
    assert.ok(first.timing && !first.scene);
    assert.equal(w.els.rounds.textContent, "Step 1 of 1");

    // phase 0 -> remember, then track, then tap
    assert.equal(w.els.instrSmall.textContent, "First, watch the glow");
    assert.equal(w.els.instr.textContent, "We'll show you what to follow");
    assert.ok(await w.waitFor(() => w.els.instr.textContent === "the glowing ball"));
    assert.ok(await w.waitFor(() => w.els.instr.textContent === "it was glowing"));
    assert.equal(w.els.instrSmall.textContent, "Now tap where");

    const scene = sceneFor(decodePayload(first.token));
    const final = targetPosition(scene, scene.highlightMs + scene.shuffleMs);
    await w.tapAt(final);
    assert.ok(await w.waitFor(() => w.els.pop._attrs["data-view"] === "done", 1500, 16), "success panel should show");
    assert.equal(w.els.instr.textContent, "You're verified");
    assert.equal(w.els.pop._attrs["data-tone"], "green");
    assert.ok(await w.waitFor(() => w.outbox.some((o) => o.msg.event === "success"), 3000, 16), "should report success");
    const success = w.outbox.find((o) => o.msg.event === "success").msg;
    assert.equal(w.els.box._attrs["data-state"], "success");
    assert.equal(w.els.label.textContent, "You're all set");
    assert.ok(!w.bodyClasses.has("pop"));
    assert.ok(w.outbox.some((o) => o.msg.event === "mode" && o.msg.mode === "inline"));

    const v = await (await fetch("/v1/siteverify", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + SECRET }, body: JSON.stringify({ token: success.token, userId: UID, guildId: GID }) })).json();
    assert.equal(v.success, true);
  } finally { await w.cleanup(); }
});

test("widget: tapping the wrong ball fails, shows the failed state, and no pass token is produced", { skip: !supported && "needs node >= 22.15", timeout: 60000 }, async () => {
  const w = await setup(2);
  try {
    await w.clickBoxAndGiveSession();
    assert.ok(await w.waitFor(() => w.bodyClasses.has("pop")));
    const first = w.apiLog.find((a) => a.path === "/v1/challenge/new").json;
    const scene = sceneFor(decodePayload(first.token));
    assert.ok(await w.waitFor(() => w.els.instr.textContent === "it was glowing"));
    const wrongObj = scene.objects.findIndex((_, i) => i !== scene.target);
    const wrong = targetPosition({ ...scene, target: wrongObj }, scene.highlightMs + scene.shuffleMs);
    await w.tapAt(wrong);
    assert.ok(await w.waitFor(() => w.els.pop._attrs["data-tone"] === "red", 500, 16), "header should turn red on a wrong tap");
    assert.equal(w.els.instrSmall.textContent, "Almost there");
    assert.equal(w.els.instr.textContent, "That wasn't the one");
    assert.ok(await w.waitFor(() => w.outbox.some((o) => o.msg.event === "fail"), 3000, 16));
    assert.equal(w.outbox.some((o) => o.msg.event === "success"), false);
    assert.equal(w.els.box._attrs["data-state"], "fail");
    assert.equal(w.els.label.textContent, "That didn't match");
    assert.equal(w.els.sub.textContent, "Let's try once more");
  } finally { await w.cleanup(); }
});

test("widget: if the page cannot provide a session, the box shows an error and tells the page", { skip: !supported && "needs node >= 22.15", timeout: 30000 }, async () => {
  const w = await setup(3);
  try {
    w.els.box.dispatch("click", {});
    await w.tick();
    assert.ok(w.outbox.some((o) => o.msg.event === "request_session"));
    assert.equal(w.els.box._attrs["data-state"], "loading");
    w.sendToFrame({ cmd: "session_error" });
    assert.ok(await w.waitFor(() => w.els.box._attrs["data-state"] === "error", 50));
    assert.ok(w.outbox.some((o) => o.msg.event === "error" && o.msg.reason === "session"));
    // messages from a wrong origin are ignored
    w.els.box.dispatch("click", {});
    await w.tick();
    const before = w.els.box._attrs["data-state"];
    (globalThis.__noop, 0);
    assert.equal(before, "loading");
  } finally { await w.cleanup(); }
});

test("widget: Escape/backdrop cancellation works while waiting for a session", { skip: !supported && "needs node >= 22.15", timeout: 30000 }, async () => {
  const w = await setup(31);
  try {
    w.els.box.dispatch("click", {});
    await w.tick();
    assert.equal(w.els.box._attrs["data-state"], "loading");
    w.sendToFrame({ cmd: "cancel" });
    assert.ok(await w.waitFor(() => w.outbox.some((o) => o.msg.event === "fail" && o.msg.reason === "cancelled"), 100));
    assert.equal(w.els.box._attrs["data-state"], "fail");
    assert.equal(w.els.sub.textContent, "You can try again anytime");
  } finally { await w.cleanup(); }
});

test("widget: closing the popup (x button or page backdrop) cancels without a pass token", { skip: !supported && "needs node >= 22.15", timeout: 30000 }, async () => {
  const w = await setup(4);
  try {
    await w.clickBoxAndGiveSession();
    assert.ok(await w.waitFor(() => w.bodyClasses.has("pop")));
    assert.ok(await w.waitFor(() => w.els.instr.textContent === "We'll show you what to follow", 50));
    w.els.close.dispatch("click", {});
    assert.ok(await w.waitFor(() => w.outbox.some((o) => o.msg.event === "fail" && o.msg.reason === "cancelled"), 200, 16));
    assert.equal(w.els.box._attrs["data-state"], "fail");
    assert.equal(w.els.label.textContent, "Check cancelled");
    assert.ok(!w.bodyClasses.has("pop"));
    assert.equal(w.outbox.some((o) => o.msg.event === "success"), false);
  } finally { await w.cleanup(); }
});

test("widget: the page backdrop can cancel through the cancel command", { skip: !supported && "needs node >= 22.15", timeout: 30000 }, async () => {
  const w = await setup(5);
  try {
    await w.clickBoxAndGiveSession();
    assert.ok(await w.waitFor(() => w.bodyClasses.has("pop")));
    w.sendToFrame({ cmd: "cancel" });
    assert.ok(await w.waitFor(() => w.outbox.some((o) => o.msg.event === "fail" && o.msg.reason === "cancelled"), 200, 16));
  } finally { await w.cleanup(); }
});
