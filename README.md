# Axex Orbit

Axex Orbit is a production-oriented, high-risk, pixel-only temporal CAPTCHA service for Discord verification. It is an additional verification layer, not a replacement for Turnstile in unsupported or repeatedly failing cases.

> Production risk: application hardening is implemented, but behavior thresholds must be calibrated against real mouse and touch traces and the widget must be manually validated on supported desktop/mobile browsers before broad rollout.

## Architecture
Portal backend -> authenticated Orbit API -> PostgreSQL replay store -> bounded PNG renderer. The browser receives raster pixels through a constrained iframe; scene coordinates and target identity are never exposed.

## Security
- HMAC-SHA-256 with cryptographically random secrets.
- Versioned signing keys with up to three previous keys for rotation.
- Constant-time comparisons.
- PostgreSQL replay protection for multi-instance production.
- Bounded memory replay storage for development/test only.
- Strict production configuration; no secret fallbacks.
- Fastify request schemas and a 32 KiB body limit.
- Generic client-facing failures; detailed reasons stay server-side.
- CSP frame-ancestors, restrictive security headers and no wildcard CORS.
- Bounded per-IP/per-token rate-limit state.
- PNG response limits, request timeouts and graceful shutdown.
- Privacy-safe request IDs with auth/cookie redaction.

## Accessibility
The visual puzzle remains a pointer-based security control. The widget provides keyboard-focusable controls, visible focus, reduced-motion and high-contrast preferences, touch-sized controls, orientation support, and a Need help action. The help action must connect to the portal's accessible verification or staff-review flow; it is not a security bypass.

## Privacy and retention
Orbit stores only replay identifiers and expiry in persistent storage. It does not intentionally persist browser fingerprints, raw mouse paths, IP addresses or challenge images. Logs contain request IDs and coarse rejection reasons, with authorization/cookies redacted. Expired replay rows are periodically removed.

## Operations
- /health/live: process liveness.
- /health/ready: replay-store readiness; returns 503 when PostgreSQL is unavailable.
- /health: compatibility endpoint.
- Optional authenticated /metrics: bounded challenge counters and p50/p95/p99 latency samples.
On PostgreSQL failure, do not silently fall back to memory in production. Restore connectivity, verify readiness, then resume traffic.

## API compatibility
Existing /v1/session, /v1/challenge/new, /v1/challenge/frame, /v1/challenge/answer, and /v1/siteverify paths remain unchanged. The server-side Node SDK remains compatible while rejecting unsafe base URLs and weak secrets.

## Deployment
Production requires PostgreSQL over TLS, exact HTTPS ALLOWED_ORIGINS, an HTTPS ORBIT_PUBLIC_URL, unique secrets, and a trusted reverse proxy if TRUST_PROXY=1.
Docker runs as the non-root node user. Recommended runtime restrictions are read-only filesystem, dropped capabilities and no-new-privileges.

## Threat model
Orbit raises automation cost by withholding scene semantics and requiring temporal visual tracking. It does not claim to defeat determined computer-vision solvers. Keep Turnstile in front of Orbit for unsupported/repeatedly failing cases.

## Testing
npm ci
npm run check
npm run testSecurity
npm run testA11y
npm run redteam
npm run audit
docker build -t axex-orbit:test .

## Release checklist
- Calibrate behavior thresholds on real mouse and touch traces.
- Configure PostgreSQL/TLS and verify readiness.
- Configure exact HTTPS origins.
- Generate unique secrets.
- Run all test/security checks and container startup checks.
- Validate desktop/mobile browser behavior.
- Keep Turnstile fallback enabled.
- Publish immutable versioned artifacts.