import test from "node:test";
import assert from "node:assert/strict";
import { generateScene, PRESETS, positionAt, R, W, H } from "../src/scene.js";

test("same seed gives identical scene, different seed differs", () => {
  const a = generateScene("seed-1", PRESETS.high);
  const b = generateScene("seed-1", PRESETS.high);
  const c = generateScene("seed-2", PRESETS.high);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("objects start well separated and stay inside the canvas forever", () => {
  for (let s = 0; s < 50; s++) {
    const sc = generateScene("bounds-" + s, PRESETS.extreme);
    const pts = sc.objects.map((o) => positionAt(o, 0));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) >= 2 * R + 10 - 1e-9);
    for (const o of sc.objects) {
      for (let t = 0; t < 30000; t += 250) {
        const [x, y] = positionAt(o, t);
        assert.ok(x >= R - 0.01 && x <= W - R + 0.01 && y >= R - 0.01 && y <= H - R + 0.01, `out of bounds ${x},${y}`);
      }
    }
  }
});

test("objects are static during the highlight phase", () => {
  const sc = generateScene("static", PRESETS.high);
  const o = sc.objects[0];
  assert.deepEqual(positionAt(o, -500), positionAt(o, 0));
});
