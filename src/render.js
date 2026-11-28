import { deflateSync } from "node:zlib";
import { objectPosition } from "./scene.js";

const AMBER = [245, 158, 11];
const LIGHT = { bg: [243, 246, 251], grid: [83, 107, 161, 22], ring: [154, 163, 178, 48], ballA: [127, 160, 255], ballB: [47, 91, 224], shadow: [0, 0, 0, 30], spark: [74, 104, 171, 120], orbit: [49, 94, 251, 52], signal: [0, 143, 168] };
const DARK = { bg: [35, 41, 56], grid: [174, 190, 255, 18], ring: [255, 255, 255, 18], ballA: [142, 170, 255], ballB: [60, 99, 230], shadow: [0, 0, 0, 100], spark: [195, 208, 255, 140], orbit: [142, 170, 255, 62], signal: [113, 225, 255] };

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function blend(px, i, color, alpha = color[3] ?? 255) {
  const a = clamp(alpha / 255, 0, 1);
  const inv = 1 - a;
  px[i] = Math.round(color[0] * a + px[i] * inv);
  px[i + 1] = Math.round(color[1] * a + px[i + 1] * inv);
  px[i + 2] = Math.round(color[2] * a + px[i + 2] * inv);
  px[i + 3] = 255;
}
function pixel(px, w, x, y, color, alpha = color[3] ?? 255) {
  x = Math.round(x); y = Math.round(y);
  const h = px.length / (w * 4);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  blend(px, i, color, alpha);
}
function line(px, w, x0, y0, x1, y1, color, alpha = color[3] ?? 255) {
  let dx = Math.abs(Math.round(x1) - Math.round(x0)), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(Math.round(y1) - Math.round(y0)), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  while (true) {
    pixel(px, w, x0, y0, color, alpha);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function circle(px, w, cx, cy, r, color, alpha = color[3] ?? 255) {
  const minX = Math.floor(cx - r), maxX = Math.ceil(cx + r);
  const minY = Math.floor(cy - r), maxY = Math.ceil(cy + r), rr = r * r;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const dx = x - cx, dy = y - cy, d = dx * dx + dy * dy;
    if (d <= rr) {
      const edge = clamp((r * r - d) / Math.max(1, r * r * 0.35), 0, 1);
      pixel(px, w, x, y, color, alpha * edge);
    }
  }
}
function gradientCircle(px, w, cx, cy, r, a, b, alpha = 255) {
  const minX = Math.floor(cx - r), maxX = Math.ceil(cx + r);
  const minY = Math.floor(cy - r), maxY = Math.ceil(cy + r), rr = r * r;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const dx = x - cx, dy = y - cy, d = dx * dx + dy * dy;
    if (d <= rr) {
      const edge = clamp((r * r - d) / Math.max(1, r * r * 0.25), 0, 1);
      const light = clamp(1 - Math.hypot(dx + r * 0.35, dy + r * 0.4) / (r * 1.5), 0, 1);
      const c = [Math.round(b[0] + (a[0] - b[0]) * light), Math.round(b[1] + (a[1] - b[1]) * light), Math.round(b[2] + (a[2] - b[2]) * light)];
      pixel(px, w, x, y, c, alpha * edge);
    }
  }
}
function ellipse(px, w, cx, cy, rx, ry, color, alpha = color[3] ?? 255) {
  const steps = 96;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pixel(px, w, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, color, alpha);
  }
}
function ring(px, w, cx, cy, r, color, alpha = color[3] ?? 255) { ellipse(px, w, cx, cy, r, r, color, alpha); }
function signalBall(px, w, x, y, r, pal, alpha = 255) {
  // Layered lighting gives the low-resolution PNG a soft, dimensional finish
  // without exposing any additional scene data to the browser.
  gradientCircle(px, w, x, y, r, pal.ballA, pal.ballB, alpha);
  ring(px, w, x, y, r - 0.7, [255, 255, 255], Math.round(alpha * 0.18));
  circle(px, w, x - r * 0.3, y - r * 0.34, r * 0.42, [255, 255, 255], alpha * 0.13);
  circle(px, w, x - r * 0.34, y - r * 0.39, r * 0.18, [255, 255, 255], alpha * 0.42);
  ellipse(px, w, x + r * 0.08, y + r * 0.52, r * 0.53, r * 0.16, [19, 49, 147], alpha * 0.12);
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const n of buf) { c ^= n; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}
function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
}

export function renderChallengeFrame(scene, t, dark = false) {
  const W = scene.W, H = scene.H, pal = dark ? DARK : LIGHT;
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = pal.bg[0]; px[i + 1] = pal.bg[1]; px[i + 2] = pal.bg[2]; px[i + 3] = 255; }
  for (let x = 30; x < W; x += 30) line(px, W, x, 0, x, H - 1, pal.grid);
  for (let y = 30; y < H; y += 30) line(px, W, 0, y, W - 1, y, pal.grid);
  const cx = W / 2, cy = H / 2;
  ellipse(px, W, cx, cy, 132, 78, pal.orbit);
  ellipse(px, W, cx, cy, 78, 132, pal.orbit);
  ring(px, W, cx, cy, 60, pal.ring);
  ring(px, W, cx, cy, 115, pal.ring);
  for (let i = 0; i < 22; i++) {
    const x = (i * 83 + 17) % W, y = (i * 47 + 29) % H;
    const alpha = 50 + Math.round(35 * (0.5 + 0.5 * Math.sin(t / 420 + i * 1.7)));
    circle(px, W, x, y, i % 5 === 0 ? 1.5 : 1, pal.spark, alpha);
  }
  for (let i = 0; i < 3; i++) {
    const a = t / (1800 + i * 260) + i * 2.1;
    const x = cx + Math.cos(a) * (106 + i * 13), y = cy + Math.sin(a) * (58 + i * 9);
    circle(px, W, x, y, 3, i === 1 ? AMBER : pal.signal, 190);
  }
  const moving = t > scene.highlightMs && t < scene.highlightMs + scene.shuffleMs;
  for (const ob of scene.objects) {
    const [x, y] = objectPosition(scene, ob, t);
    ellipse(px, W, x, y + scene.R + 4, scene.R * 0.72, 3.2, pal.shadow, pal.shadow[3]);
    if (moving) for (let k = 3; k >= 1; k--) {
      const [tx, ty] = objectPosition(scene, ob, t - k * 40);
      signalBall(px, W, tx, ty, scene.R * (1 - k * 0.15), pal, 16 + (3 - k) * 5);
    }
    signalBall(px, W, x, y, scene.R, pal);
  }
  const [tx, ty] = objectPosition(scene, scene.objects[scene.target], t);
  if (t < scene.highlightMs) {
    circle(px, W, tx, ty, scene.R + 11, AMBER, 35);
    ring(px, W, tx, ty, scene.R + 8, [255, 190, 62], 225);
    ring(px, W, tx, ty, scene.R + 11, [255, 255, 255], 90);
    signalBall(px, W, tx, ty, scene.R, { ...pal, ballA: [255, 224, 145], ballB: AMBER });
  }
  return png(W, H, px);
}
