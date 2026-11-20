// Axex Orbit core. Pure logic, no HTTP. Stateless: all state lives in signed tokens,
// the store only remembers which token ids were already used (replay protection).
import { PRESETS, generateScene, targetPosition } from "./scene.js";
import { scorePointer } from "./behavior.js";
import { sign, verify, randomId, deriveSeed } from "./token.js";
import { renderChallengeFrame } from "./render.js";

const SESSION_TTL_MS = 5 * 60 * 1000;
const PASS_TTL_MS = 2 * 60 * 1000;
const HIT_SLACK = 8; // px of tolerance around the ball radius (finger size); balls are frozen so no latency slack is needed
const SNOWFLAKE = /^\d{15,25}$/;

export function createOrbit({ signingKey, store, now = Date.now, presets = PRESETS, minBehavior = 0.5 }) {
  if (!signingKey || signingKey.length < 32) throw new Error("signingKey must be at least 32 chars");

  const fail = (reason) => ({ ok: false, reason });

  function issueChallenge({ cid, uid, gid, diff, round, bs }) {
    const preset = presets[diff];
    const iat = now();
    const scene = generateScene(deriveSeed(signingKey, cid, round), preset);
    const lifetime = scene.highlightMs + scene.shuffleMs + scene.windowMs + 20000;
    const token = sign({ typ: "chal", jti: randomId(), cid, uid, gid, diff, round, rounds: preset.rounds, bs, iat, exp: iat + lifetime }, signingKey);
    return { token, round, rounds: preset.rounds, timing: { W: scene.W, H: scene.H, highlightMs: scene.highlightMs, shuffleMs: scene.shuffleMs, windowMs: scene.windowMs } };
  }

  function validAnswerShape(answer, scene) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return false;
    if (![answer.x, answer.y, answer.t].every((n) => typeof n === "number" && Number.isFinite(n))) return false;
    if (answer.x < -HIT_SLACK || answer.x > scene.W + HIT_SLACK || answer.y < -HIT_SLACK || answer.y > scene.H + HIT_SLACK) return false;
    if (answer.path === undefined) return true;
    if (!Array.isArray(answer.path) || answer.path.length > 120) return false;
    return answer.path.every((p) => Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number" && Number.isFinite(n)));
  }

  // Called by the portal BACKEND (secret key). Difficulty is fixed here, so the client can't downgrade it.
  async function createSession({ userId, guildId, difficulty }) {
    if (!SNOWFLAKE.test(String(userId)) || !SNOWFLAKE.test(String(guildId))) return fail("bad_binding");
    if (!presets[difficulty]) return fail("bad_difficulty");
    const iat = now();
    const session = sign({ typ: "sess", jti: randomId(), uid: String(userId), gid: String(guildId), diff: difficulty, iat, exp: iat + SESSION_TTL_MS }, signingKey);
    return { ok: true, session, expiresInMs: SESSION_TTL_MS };
  }

  // Called by the widget in the browser. One session = one attempt.
  async function startChallenge({ session }) {
    const v = verify(session, signingKey, "sess", now());
    if (!v.ok) return fail(v.reason);
    const p = v.payload;
    if (!(await store.markUsed("s:" + p.jti, SESSION_TTL_MS))) return fail("replay");
    const cid = randomId(9);
    return { ok: true, ...issueChallenge({ cid, uid: p.uid, gid: p.gid, diff: p.diff, round: 1, bs: [] }) };
  }

  async function submitAnswer({ token, answer }) {
    const v = verify(token, signingKey, "chal", now());
    if (!v.ok) return fail(v.reason);
    const c = v.payload;
    // Consume first: every round token is single-use, a wrong answer can never be retried on the same scene.
    if (!(await store.markUsed("c:" + c.jti, c.exp - c.iat + 60000))) return fail("replay");

    const scene = generateScene(deriveSeed(signingKey, c.cid, c.round), presets[c.diff]);
    if (!validAnswerShape(answer, scene)) return { ...fail("failed"), detail: "shape" };
    const { x, y, t } = answer;
    const answerStart = scene.highlightMs + scene.shuffleMs;
    if (t < answerStart || t > answerStart + scene.windowMs) return { ...fail("failed"), detail: "timing_window" };

    // Client timers can't run faster than real time: reject claimed times that the server clock can't support.
    const elapsed = now() - c.iat;
    if (elapsed < t - 400) return { ...fail("failed"), detail: "clock" };

    const tp = targetPosition(scene, t);
    if (Math.hypot(x - tp[0], y - tp[1]) > scene.R + HIT_SLACK) return { ...fail("failed"), detail: "miss" };

    const b = scorePointer(answer, tp);
    if (b.hardFail || b.score < minBehavior) return { ...fail("failed"), detail: "behavior:" + b.flags.join(",") };

    const bs = [...c.bs, Math.round(b.score * 100) / 100];
    if (c.round < c.rounds) {
      return { ok: true, done: false, ...issueChallenge({ cid: c.cid, uid: c.uid, gid: c.gid, diff: c.diff, round: c.round + 1, bs }) };
    }
    const iat = now();
    const avg = bs.reduce((a, n) => a + n, 0) / bs.length;
    const pass = sign({ typ: "pass", jti: randomId(), cid: c.cid, uid: c.uid, gid: c.gid, diff: c.diff, rounds: c.rounds, bs: Math.round(avg * 100) / 100, iat, exp: iat + PASS_TTL_MS }, signingKey);
    return { ok: true, done: true, passToken: pass };
  }

  async function renderFrame({ token, t, dark = false }) {
    const v = verify(token, signingKey, "chal", now());
    if (!v.ok || typeof t !== "number" || !Number.isFinite(t)) return fail("invalid");
    const c = v.payload;
    const scene = generateScene(deriveSeed(signingKey, c.cid, c.round), presets[c.diff]);
    const max = scene.highlightMs + scene.shuffleMs + scene.windowMs;
    if (t < 0 || t > max + 1000) return fail("invalid");
    return { ok: true, png: renderChallengeFrame(scene, t, dark === true), width: scene.W, height: scene.H };
  }

  // Called by the portal BACKEND (secret key) before it trusts the result.
  async function siteverify({ token, userId, guildId }) {
    const v = verify(token, signingKey, "pass", now());
    if (!v.ok) return { success: false, reason: v.reason };
    const p = v.payload;
    if (!SNOWFLAKE.test(String(userId)) || !SNOWFLAKE.test(String(guildId))) return { success: false, reason: "binding_required" };
    if (String(userId) !== p.uid || String(guildId) !== p.gid) return { success: false, reason: "binding_mismatch" };
    if (!(await store.markUsed("p:" + p.jti, PASS_TTL_MS + 60000))) return { success: false, reason: "replay" };
    return { success: true, userId: p.uid, guildId: p.gid, difficulty: p.diff, rounds: p.rounds, behaviorScore: p.bs, challengeId: p.cid, issuedAt: p.iat };
  }

  return { createSession, startChallenge, submitAnswer, renderFrame, siteverify };
}
