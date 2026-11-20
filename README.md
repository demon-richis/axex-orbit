# Axex Orbit

"Track & Tap" captcha for **high-risk** Discord verification (replaces Turnstile on the High level only).
The user remembers a highlighted ball, the balls then move and cross each other, and the user taps the remembered one.

Stateless Node service (Fastify). Runs anywhere: Docker, Railway, Render, Fly.io, VPS.

## Flow (Turnstile-style)
```
Portal backend --POST /v1/session (secret)--> Orbit          -> { session }   (difficulty is fixed here)
Browser widget --POST /v1/challenge/new { session }-->        -> round 1 scene
Browser widget --POST /v1/challenge/answer { token, answer }-> next round | passToken | fail
Portal backend --POST /v1/siteverify (secret) { token, userId, guildId }--> { success, behaviorScore, ... }
```
* One session = one attempt. Attempt counting / cooldowns / lock stay in the portal state machine.
* Every token (session, round, pass) is HMAC-signed and single-use (replay store: memory, or Postgres via `DATABASE_URL`).
* The pass token is bound to Discord `userId` + `guildId`. `siteverify` requires both bindings and consumes the pass token exactly once; never trust a client-side "passed".
* Failures return only a coarse reason (`failed`/`invalid`), details go to server logs.
* Browser responses include restrictive CSP, frame-ancestor, permissions, referrer, and cross-origin isolation headers. Browser challenge answers are rate-limited by both client IP and token fingerprint.
* Answer telemetry is bounded and validated before behavior scoring; malformed or oversized telemetry consumes the challenge token rather than creating a retry oracle.

## Embed (portal page)
Looks like a normal captcha: a small "Verify you are human" box. Click -> the challenge opens as a centered popup -> collapses back to the box (green "Verified" on success).
```html
<script src="https://ORBIT_HOST/widget/embed.js"></script>
<div id="captcha"></div>
<script>
  AxexOrbit.render(document.getElementById("captcha"), {
    // called on every click/retry: ask YOUR backend for a fresh session (POST /v1/session, one session = one attempt)
    getSession: () => fetch("/api/orbit-session").then(r => r.json()).then(j => j.session),
    onSuccess: (token) => { /* send token to YOUR backend, which calls siteverify */ },
    onFail: (reason) => {}, onError: (reason) => {}, onHelp: () => { /* route to staff review */ },
  });
</script>
```
Set `ALLOWED_ORIGINS` to your portal origin, otherwise the iframe is refused (CSP `frame-ancestors`).

## How the challenge plays
1. Balls appear, one glows: "Remember this ball".
2. All balls look the same and move around, crossing each other: "Keep your eyes on it...".
3. Balls stop: "Which ball was it? Tap it!". Right tap -> next round / verified, wrong tap -> failed (the right one is revealed).

## Portal backend (Node)
```js
import { OrbitClient } from "axex-orbit/sdk/index.js";
const orbit = new OrbitClient({ baseUrl: process.env.ORBIT_URL, secret: process.env.ORBIT_SITE_SECRET });
const { session } = await orbit.createSession({ userId, guildId, difficulty: "high" });
// ... later
const r = await orbit.siteverify({ token, userId, guildId }); // r.success === true
```
Any other language: plain HTTP with `Authorization: Bearer <ORBIT_SITE_SECRET>`.

## Difficulty presets (`src/scene.js`)
| level | rounds | balls | speed |
|---|---|---|---|
| medium | 1 | 8 | 0.8 |
| high | 2 | 12 | 1.0 |
| extreme | 3 | 14 | 1.15 |

## Run
```
cp .env.example .env   # fill secrets
npm ci && npm test && npm start
npm run redteam        # attacker simulation (see below)
```

## HONEST threat model (read this)
`npm run redteam` result on the current MVP (high, 500 attempts each):
* blind random click: **0%**
* script that reads the scene data and teleport-clicks: **0%** (behavior check)
* script that reads the scene data and clicks along a straight synthetic mouse line: **0%**
* script that reads the scene data **and** fakes a human-like mouse path: **100%**

So the MVP stops lazy bots and vision-free clickers, adds server-side timing/behavior checks, makes every attempt unique and single-use,
but **a determined attacker who reads the widget's JSON (or runs the widget in a real browser and reads it) can solve it for ~zero marginal cost.**
The scene must be sent to the browser to be drawn, so it can always be read. Do not claim a "10000x cost" with this version.

### Phase 2 (what actually multiplies per-solve cost): pixel-only delivery
Server renders the frames (e.g. skia-canvas, short WebM/WebP sequence with per-challenge noise/distractors) and the browser only shows
video and sends click coordinates. No coordinates ever reach the client, so a solver needs vision + tracking per attempt.
Costs: server CPU/bandwidth, latency, accessibility fallback. Also keep: failure = locked attempt in the portal, review queue for edge cases.

### Other limits
* Behavior thresholds are heuristics tested only with a synthetic mouse. **Calibrate on real human traces (mouse + touch) before production**; tune `MIN_BEHAVIOR`.
* The widget logic is tested end to end with a fake DOM (checkbox -> popup -> rounds -> verdict -> siteverify), but it was never opened in a real browser in the build sandbox. Check the look and touch behavior manually on desktop + phone.
* `PgStore` (Postgres replay store) is untested in the build sandbox. Use the memory store on a single instance until you have run it against Neon.
* Keep Turnstile as a base layer in front of Orbit for headless-browser signals.
* Accessibility: the "Need help?" button emits `onHelp` so the portal can route the user to staff review.
