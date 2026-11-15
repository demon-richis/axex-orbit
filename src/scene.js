// Scene generation + analytic object motion. Browser + Node compatible.
// Positions are a pure function of (object params, time) -> no physics drift between client and server.
import { rngFromSeed } from "./prng.js";

export const W = 360;
export const H = 270;
export const R = 16; // object radius (logical px)

// Difficulty presets. "medium" is mostly for testing; Orbit is meant for HIGH risk.
export const PRESETS = {
  medium: { rounds: 1, objects: 6, speed: 0.8, highlightMs: 2200, shuffleMs: 4000, windowMs: 12000 },
  high: { rounds: 2, objects: 8, speed: 1.0, highlightMs: 2000, shuffleMs: 5000, windowMs: 12000 },
  extreme: { rounds: 3, objects: 10, speed: 1.2, highlightMs: 1800, shuffleMs: 6000, windowMs: 10000 },
};

export function positionAt(o, tauMs) {
  const t = Math.max(0, tauMs) / 1000;
  return [o.cx + o.ax * Math.sin(o.wx * t + o.px), o.cy + o.ay * Math.sin(o.wy * t + o.py)];
}

function buildObject(rnd, speed) {
  const ax = 30 + rnd() * (W / 2 - R - 30);
  const ay = 24 + rnd() * (H / 2 - R - 24);
  return {
    ax,
    ay,
    cx: R + ax + rnd() * (W - 2 * R - 2 * ax),
    cy: R + ay + rnd() * (H - 2 * R - 2 * ay),
    wx: speed * (0.45 + rnd() * 1.1),
    wy: speed * (0.45 + rnd() * 1.1),
    px: rnd() * Math.PI * 2,
    py: rnd() * Math.PI * 2,
  };
}

export function generateScene(seed, preset) {
  const rnd = rngFromSeed(seed);
  const minGap = 2 * R + 10;
  let objects = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    objects = Array.from({ length: preset.objects }, () => buildObject(rnd, preset.speed));
    const pts = objects.map((o) => positionAt(o, 0));
    let ok = true;
    for (let i = 0; i < pts.length && ok; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < minGap) {
          ok = false;
          break;
        }
      }
    }
    if (ok) break;
  }
  return {
    W,
    H,
    R,
    highlightMs: preset.highlightMs,
    shuffleMs: preset.shuffleMs,
    windowMs: preset.windowMs,
    objects: objects.map((o) => ({ ...o, ax: round3(o.ax), ay: round3(o.ay), cx: round3(o.cx), cy: round3(o.cy), wx: round3(o.wx), wy: round3(o.wy), px: round3(o.px), py: round3(o.py) })),
    target: Math.floor(rnd() * preset.objects),
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// Where the target is at `tMs` since round start (objects are static until highlight ends).
export function targetPosition(scene, tMs) {
  return positionAt(scene.objects[scene.target], tMs - scene.highlightMs);
}
