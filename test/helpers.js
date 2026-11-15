import { mulberry32 } from "../src/prng.js";
import { PRESETS, generateScene } from "../src/scene.js";
import { deriveSeed } from "../src/token.js";

export const KEY = "test-signing-key-0123456789-abcdefghijkl";
export const UID = "123456789012345678";
export const GID = "987654321098765432";

export function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => (t += ms);
  return fn;
}

// Reproduce the scene the server will check (same derivation as orbit.js).
export function sceneFor(chalPayload, presets = PRESETS) {
  return generateScene(deriveSeed(KEY, chalPayload.cid, chalPayload.round), presets[chalPayload.diff]);
}

export function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

// Synthetic "human-like" pointer path: eased curve with noise and uneven timing.
// This is NOT a real human; it only checks that benign-looking input is not rejected.
export function humanLikeAnswer(targetPos, t, seed = 1) {
  const rnd = mulberry32(seed);
  const sx = 40 + rnd() * 250;
  const sy = 30 + rnd() * 200;
  const ex = targetPos[0] + (rnd() - 0.5) * 14;
  const ey = targetPos[1] + (rnd() - 0.5) * 14;
  const n = 30 + Math.floor(rnd() * 20);
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(8 + rnd() * 14);
  const times = new Array(n + 1);
  times[n] = t;
  for (let i = n - 1; i >= 0; i--) times[i] = times[i + 1] - steps[i]; // build backwards so the path ends exactly at click time
  const path = [];
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    const e = p * p * (3 - 2 * p);
    const bow = Math.sin(p * Math.PI) * 18 * (rnd() - 0.3);
    path.push([sx + (ex - sx) * e + bow + (rnd() - 0.5) * 1.5, sy + (ey - sy) * e - bow + (rnd() - 0.5) * 1.5, times[i]]);
  }
  const last = path[path.length - 1];
  return { x: last[0], y: last[1], t, pt: "mouse", trusted: true, path };
}
