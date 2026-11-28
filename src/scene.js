// Scene generation + analytic object motion. Browser + Node compatible.
// Positions are a pure function of (object params, time) -> no physics drift between client and server.
import { rngFromSeed } from "./prng.js";

export const W = 360;
export const H = 270;
export const R = 16; // object radius (logical px)

// Difficulty presets. "medium" is mostly for testing; Orbit is meant for HIGH risk.
export const PRESETS = {
  medium: { rounds: 1, objects: 7, speed: 0.68, highlightMs: 2400, shuffleMs: 5000, windowMs: 15000 },
  high: { rounds: 2, objects: 9, speed: 0.82, highlightMs: 2400, shuffleMs: 6500, windowMs: 15000 },
  extreme: { rounds: 3, objects: 11, speed: 0.96, highlightMs: 2200, shuffleMs: 7200, windowMs: 12000 },
};

export function positionAt(o, tauMs) {
  const t = Math.max(0, tauMs) / 1000;
  return [o.cx + o.ax * Math.sin(o.wx * t + o.px), o.cy + o.ay * Math.sin(o.wy * t + o.py)];
}

function buildObject(rnd, speed) {
  const ax = 30 + rnd() * (W / 2 - R - 30);
  const ay = 24 + rnd() * (H / 2 - R - 24);
  const o = {
    ax,
    ay,
    cx: R + ax + rnd() * (W - 2 * R - 2 * ax),
    cy: R + ay + rnd() * (H - 2 * R - 2 * ay),
    wx: speed * (0.45 + rnd() * 1.1),
    wy: speed * (0.45 + rnd() * 1.1),
    px: rnd() * Math.PI * 2,
    py: rnd() * Math.PI * 2,
  };
  // round here so separation checks use the exact values client and server will use
  for (const k of Object.keys(o)) o[k] = Math.round(o[k] * 1000) / 1000;
  return o;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Balls move from their start spot to a final "frozen" spot (at shuffleMs).
// Both the start layout and the final layout must keep balls apart so every tap is unambiguous.
export function generateScene(seed, preset) {
  const rnd = rngFromSeed(seed);
  const objects = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < preset.objects; i++) {
    let placed = false;
    for (let relax = 0; relax < 4 && !placed; relax++) {
      const gap = (2 * R + 10) * (1 - relax * 0.1);
      for (let attempt = 0; attempt < 400 && !placed; attempt++) {
        const o = buildObject(rnd, preset.speed);
        const s = positionAt(o, 0);
        const e = positionAt(o, preset.shuffleMs);
        if (starts.every((p) => dist(p, s) >= gap) && ends.every((p) => dist(p, e) >= gap)) {
          objects.push(o);
          starts.push(s);
          ends.push(e);
          placed = true;
        }
      }
    }
    if (!placed) throw new Error("scene generation failed");
  }
  return {
    W,
    H,
    R,
    highlightMs: preset.highlightMs,
    shuffleMs: preset.shuffleMs,
    windowMs: preset.windowMs,
    objects,
    target: Math.floor(rnd() * preset.objects),
  };
}

// Position of a ball `tMs` after the round started. Static during the highlight phase, frozen after shuffleMs.
export function objectPosition(scene, o, tMs) {
  const tau = Math.min(Math.max(0, tMs - scene.highlightMs), scene.shuffleMs);
  return positionAt(o, tau);
}

// Where the target is at `tMs` since round start (this is the frozen spot once the balls stop).
export function targetPosition(scene, tMs) {
  return objectPosition(scene, scene.objects[scene.target], tMs);
}
