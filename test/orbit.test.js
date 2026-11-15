import test from "node:test";
import assert from "node:assert/strict";
import { createOrbit } from "../src/orbit.js";
import { MemoryStore } from "../src/store.js";
import { targetPosition } from "../src/scene.js";
import { KEY, UID, GID, fakeClock, sceneFor, decodePayload, humanLikeAnswer } from "./helpers.js";

function setup() {
  const now = fakeClock();
  const orbit = createOrbit({ signingKey: KEY, store: new MemoryStore(now), now });
  return { now, orbit };
}

async function begin(orbit, difficulty = "high") {
  const s = await orbit.createSession({ userId: UID, guildId: GID, difficulty });
  assert.equal(s.ok, true);
  const c = await orbit.startChallenge({ session: s.session });
  assert.equal(c.ok, true);
  return c;
}

// Plays a round like a (synthetic) human would: waits until the answer phase, then clicks the target.
function solve(now, c, seed = 1) {
  const payload = decodePayload(c.token);
  const scene = sceneFor(payload);
  const t = scene.highlightMs + scene.shuffleMs + 1500;
  now.advance(t + 200);
  return { token: c.token, answer: humanLikeAnswer(targetPosition(scene, t), t, seed) };
}

test("full flow: session -> rounds -> pass token -> siteverify", async () => {
  const { now, orbit } = setup();
  let c = await begin(orbit, "high");
  assert.equal(c.rounds, 2);
  let r = await orbit.submitAnswer(solve(now, c, 1));
  assert.equal(r.ok, true);
  assert.equal(r.done, false);
  assert.equal(r.round, 2);
  r = await orbit.submitAnswer(solve(now, r, 2));
  assert.equal(r.ok && r.done, true);
  const v = await orbit.siteverify({ token: r.passToken, userId: UID, guildId: GID });
  assert.equal(v.success, true);
  assert.equal(v.userId, UID);
  assert.equal(v.difficulty, "high");
  assert.ok(v.behaviorScore >= 0.5);
});

test("scene sent to the client never contains secrets (no seed, no key)", async () => {
  const { orbit } = setup();
  const c = await begin(orbit);
  const blob = JSON.stringify(c);
  assert.ok(!blob.includes(KEY));
  assert.ok(!("seed" in c.scene));
});

test("pass token is single-use and bound to user + guild", async () => {
  const { now, orbit } = setup();
  let c = await begin(orbit, "medium");
  const r = await orbit.submitAnswer(solve(now, c));
  assert.equal(r.done, true);
  assert.equal((await orbit.siteverify({ token: r.passToken, userId: "111111111111111111", guildId: GID })).reason, "binding_mismatch");
  assert.equal((await orbit.siteverify({ token: r.passToken, userId: UID, guildId: GID })).success, true);
  assert.equal((await orbit.siteverify({ token: r.passToken, userId: UID, guildId: GID })).reason, "replay");
});

test("session is single-use (one session = one attempt)", async () => {
  const { orbit } = setup();
  const s = await orbit.createSession({ userId: UID, guildId: GID, difficulty: "high" });
  assert.equal((await orbit.startChallenge({ session: s.session })).ok, true);
  assert.equal((await orbit.startChallenge({ session: s.session })).reason, "replay");
});

test("a challenge token can't be replayed, even after a correct answer", async () => {
  const { now, orbit } = setup();
  const c = await begin(orbit, "medium");
  const a = solve(now, c);
  assert.equal((await orbit.submitAnswer(a)).ok, true);
  assert.equal((await orbit.submitAnswer(a)).reason, "replay");
});

test("wrong click fails and burns the token", async () => {
  const { now, orbit } = setup();
  const c = await begin(orbit, "medium");
  const a = solve(now, c);
  a.answer.x = (a.answer.x + 120) % 340;
  a.answer.path = a.answer.path.map((p) => [p[0] + 120, p[1], p[2]]);
  const r = await orbit.submitAnswer(a);
  assert.equal(r.ok, false);
  assert.equal(r.detail, "miss");
  assert.equal((await orbit.submitAnswer(a)).reason, "replay");
});

test("answering before the answer phase is rejected", async () => {
  const { now, orbit } = setup();
  const c = await begin(orbit, "medium");
  const scene = sceneFor(decodePayload(c.token));
  const t = scene.highlightMs + 500;
  now.advance(t + 100);
  const r = await orbit.submitAnswer({ token: c.token, answer: humanLikeAnswer(targetPosition(scene, t), t) });
  assert.equal(r.detail, "timing_window");
});

test("claiming a time the server clock can't support is rejected (instant bot)", async () => {
  const { now, orbit } = setup();
  const c = await begin(orbit, "medium");
  const scene = sceneFor(decodePayload(c.token));
  const t = scene.highlightMs + scene.shuffleMs + 1000;
  now.advance(300); // only 300ms really passed
  const r = await orbit.submitAnswer({ token: c.token, answer: humanLikeAnswer(targetPosition(scene, t), t) });
  assert.equal(r.detail, "clock");
});

test("teleporting, untrusted, pixel-perfect click is rejected by behavior check", async () => {
  const { now, orbit } = setup();
  const c = await begin(orbit, "medium");
  const scene = sceneFor(decodePayload(c.token));
  const t = scene.highlightMs + scene.shuffleMs + 1000;
  now.advance(t + 100);
  const [x, y] = targetPosition(scene, t);
  const r = await orbit.submitAnswer({ token: c.token, answer: { x, y, t, pt: "mouse", trusted: false, path: [] } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^behavior:/);
});

test("expired and forged tokens", async () => {
  const { now, orbit } = setup();
  const c = await begin(orbit, "medium");
  now.advance(10 * 60 * 1000);
  assert.equal((await orbit.submitAnswer({ token: c.token, answer: {} })).reason, "expired");
  assert.equal((await orbit.submitAnswer({ token: "a.b", answer: {} })).reason, "bad_signature");
});

test("bad session input", async () => {
  const { orbit } = setup();
  assert.equal((await orbit.createSession({ userId: "abc", guildId: GID, difficulty: "high" })).reason, "bad_binding");
  assert.equal((await orbit.createSession({ userId: UID, guildId: GID, difficulty: "nightmare" })).reason, "bad_difficulty");
});

test("blind random clicking almost never passes (high, 2 rounds)", async () => {
  const { now, orbit } = setup();
  let passes = 0;
  const trials = 1500;
  for (let i = 0; i < trials; i++) {
    let c = await begin(orbit, "high");
    for (let round = 0; round < 2; round++) {
      const payload = decodePayload(c.token);
      const scene = sceneFor(payload);
      const t = scene.highlightMs + scene.shuffleMs + 1000;
      now.advance(t + 100);
      const rx = 20 + Math.random() * 320, ry = 20 + Math.random() * 230;
      const r = await orbit.submitAnswer({ token: c.token, answer: humanLikeAnswer([rx, ry], t, i + 1) });
      if (!r.ok) break;
      if (r.done) passes++;
      else c = r;
    }
  }
  assert.ok(passes / trials < 0.01, `random pass rate too high: ${passes}/${trials}`);
});
