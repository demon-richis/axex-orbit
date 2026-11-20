# Axex Orbit

"Track & Tap" captcha for **high-risk** Discord verification (replaces Turnstile on the High level only).
The user remembers a highlighted ball, the balls then move and cross each other, and the user taps the remembered one.

Stateless Node service (Fastify). Runs anywhere: Docker, Railway, Render, Fly.io, VPS.

## Flow (Turnstile-style)
```
Portal backend --POST /v1/session (secret)--> Orbit          -> { session }   (difficulty is fixed here)
Browser widget --POST /v1/challenge/new { session }-->        -> round 1 timing + token
Browser widget --POST /v1/challenge/frame { token, t }----->        <- PNG pixels
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
1. The server renders the balls and sends only PNG pixels; one ball glows: "Remember this ball".
2. The server continues sending raster frames while all balls move and cross: "Keep your eyes on it...".
3. Balls stop: "Which ball was it? Tap it!". Right tap -> next round / verified; wrong tap -> failed.

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
The browser now receives opaque raster frames, not scene JSON or object coordinates. A solver can still use screenshots, computer vision, and temporal tracking, but cannot solve by reading the scene object model or exact target coordinates from the page.

`npm run redteam` result on the core (high, 500 attempts each):
* blind random click: **0%**
* script that has server-side scene access and teleport-clicks: **0%** (behavior check)
* script that has server-side scene access and clicks along a straight synthetic mouse line: **0%**
* script that has server-side scene access **and** fakes a human-like mouse path: **100%**

So the pixel-only mode stops scene-inspection and vision-free clickers, adds server-side timing/behavior checks, makes every attempt unique and single-use, and raises determined-solver cost to screenshot understanding plus motion tracking per attempt. It does not defeat a determined computer-vision attacker.

### Pixel-only delivery tradeoffs
The server renders PNG frames with per-challenge motion, noise, and distractors; the browser only displays pixels and sends click coordinates. No object coordinates reach the client, so a solver needs vision plus tracking per attempt. Costs are server CPU/bandwidth, latency, and a need for an accessibility fallback. Keep Turnstile as a base layer and route repeated failures to portal lock/review flows.

### Other limits
* Behavior thresholds are heuristics tested only with a synthetic mouse. **Calibrate on real human traces (mouse + touch) before production**; tune `MIN_BEHAVIOR`.
* The widget logic is tested end to end with a fake DOM (checkbox -> popup -> rounds -> verdict -> siteverify), but it was never opened in a real browser in the build sandbox. Check the look and touch behavior manually on desktop + phone.
* `PgStore` (Postgres replay store) is untested in the build sandbox. Use the memory store on a single instance until you have run it against Neon.
* Keep Turnstile as a base layer in front of Orbit for headless-browser signals.
* Accessibility: the "Need help?" button emits `onHelp` so the portal can route the user to staff review.
