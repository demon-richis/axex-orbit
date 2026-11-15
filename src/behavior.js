// Human-likeness scoring of the pointer data sent with an answer.
// NOTE: thresholds are heuristics and MUST be calibrated on real human traces (see README).

const num = (v) => typeof v === "number" && Number.isFinite(v);

function cleanPath(path) {
  if (!Array.isArray(path)) return [];
  const out = [];
  for (const p of path.slice(-120)) {
    if (Array.isArray(p) && p.length >= 3 && num(p[0]) && num(p[1]) && num(p[2])) out.push([p[0], p[1], p[2]]);
  }
  return out;
}

export function scorePointer(answer, targetPos) {
  let score = 1;
  const flags = [];
  const path = cleanPath(answer.path);
  const touch = answer.pt === "touch";

  if (answer.trusted !== true) {
    score -= 0.6;
    flags.push("untrusted_event");
  }

  for (let i = 1; i < path.length; i++) {
    if (path[i][2] < path[i - 1][2]) {
      return { score: 0, flags: [...flags, "bad_timestamps"], hardFail: true };
    }
  }
  if (path.length && path[path.length - 1][2] > answer.t + 60) {
    return { score: 0, flags: [...flags, "bad_timestamps"], hardFail: true };
  }

  if (!touch && path.length < 6) {
    score -= 0.4;
    flags.push("no_movement");
  }

  if (path.length >= 3) {
    let length = 0;
    let maxSpeed = 0;
    const dts = [];
    for (let i = 1; i < path.length; i++) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      const dt = path[i][2] - path[i - 1][2];
      const d = Math.hypot(dx, dy);
      length += d;
      if (dt > 0) {
        dts.push(dt);
        maxSpeed = Math.max(maxSpeed, d / dt);
      } else if (d > 20) {
        maxSpeed = Infinity;
      }
    }
    if (maxSpeed > 6) {
      score -= 0.5;
      flags.push("teleport");
    }
    if (dts.length >= 8) {
      const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
      const sd = Math.sqrt(dts.reduce((a, b) => a + (b - mean) ** 2, 0) / dts.length);
      if (mean > 0 && sd < 0.4) {
        score -= 0.3;
        flags.push("synthetic_timing");
      }
    }
    const first = path[0];
    const last = path[path.length - 1];
    const disp = Math.hypot(last[0] - first[0], last[1] - first[1]);
    if (length > 40 && disp / length > 0.9995) {
      score -= 0.25;
      flags.push("straight_line");
    }
  }

  if (path.length) {
    const last = path[path.length - 1];
    if (Math.hypot(last[0] - answer.x, last[1] - answer.y) > 25) {
      score -= 0.3;
      flags.push("path_mismatch");
    }
  }

  if (Math.hypot(answer.x - targetPos[0], answer.y - targetPos[1]) < 0.75) {
    score -= 0.3;
    flags.push("pixel_perfect");
  }

  return { score: Math.max(0, Math.min(1, score)), flags, hardFail: false };
}
