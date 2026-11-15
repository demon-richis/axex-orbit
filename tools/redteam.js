// Measures how each attacker strategy fares against the core (no HTTP).
// Usage: node tools/redteam.js [trials]
import { createOrbit } from "../src/orbit.js";
import { MemoryStore } from "../src/store.js";
import { targetPosition } from "../src/scene.js";
import { KEY, UID, GID, fakeClock, sceneFor, decodePayload, humanLikeAnswer } from "../test/helpers.js";

const trials = Number(process.argv[2] || 500);
const difficulty = process.argv[3] || "high";

const strategies = {
  "blind random click": (scene, t, i) => humanLikeAnswer([20 + Math.random() * 320, 20 + Math.random() * 230], t, i + 1),
  "reads scene JS, teleport click (no path, untrusted)": (scene, t) => {
    const [x, y] = targetPosition(scene, t);
    return { x, y, t, pt: "mouse", trusted: false, path: [] };
  },
  "reads scene JS, straight-line synthetic mouse": (scene, t) => {
    const [x, y] = targetPosition(scene, t);
    const path = [];
    for (let k = 0; k <= 12; k++) path.push([10 + ((x - 10) * k) / 12, 10 + ((y - 10) * k) / 12, t - 120 + k * 10]);
    return { x, y, t, pt: "mouse", trusted: true, path };
  },
  "reads scene JS, human-like synthetic mouse (determined attacker)": (scene, t, i) => humanLikeAnswer(targetPosition(scene, t), t, i + 1),
};

for (const [name, play] of Object.entries(strategies)) {
  const now = fakeClock();
  const orbit = createOrbit({ signingKey: KEY, store: new MemoryStore(now), now });
  let passes = 0;
  for (let i = 0; i < trials; i++) {
    const s = await orbit.createSession({ userId: UID, guildId: GID, difficulty });
    let c = await orbit.startChallenge({ session: s.session });
    while (c.ok) {
      const scene = sceneFor(decodePayload(c.token));
      const t = scene.highlightMs + scene.shuffleMs + 1000;
      now.advance(t + 100);
      const r = await orbit.submitAnswer({ token: c.token, answer: play(scene, t, i) });
      if (!r.ok) break;
      if (r.done) { passes++; break; }
      c = r;
    }
  }
  console.log(`${(100 * passes / trials).toFixed(1).padStart(5)}%  ${name}`);
}
console.log(`\n(${trials} attempts each, difficulty=${difficulty})`);
