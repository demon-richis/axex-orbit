import Fastify from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createOrbit } from "./orbit.js";
import { loadConfig } from "./config.js";
import { MemoryStore, PgStore } from "./store.js";
import { safeEqual } from "./token.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const MAX_BODY_BYTES = 32 * 1024;
const MAX_METRIC_SAMPLES = 1000;
const MAX_FRAME_BYTES = 1_000_000;

const STATIC = {
  "/widget/frame": ["frame.html", "text/html; charset=utf-8"],
  "/widget/frame.js": ["frame.js", "text/javascript; charset=utf-8"],
  "/widget/embed.js": ["embed.js", "text/javascript; charset=utf-8"],
  "/lib/scene.js": [path.join("..", "src", "scene.js"), "text/javascript; charset=utf-8"],
  "/lib/prng.js": [path.join("..", "src", "prng.js"), "text/javascript; charset=utf-8"],
};

const schemas = {
  session: {
    body: {
      type: "object",
      required: ["userId", "guildId", "difficulty"],
      properties: {
        userId: { type: "string", minLength: 15, maxLength: 25, pattern: "^\\d+$" },
        guildId: { type: "string", minLength: 15, maxLength: 25, pattern: "^\\d+$" },
        difficulty: { type: "string", enum: ["medium", "high", "extreme"] },
      },
      additionalProperties: false,
    },
  },
  challengeNew: {
    body: {
      type: "object",
      properties: {
        session: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["session"],
      additionalProperties: true,
    },
  },
  frame: {
    body: {
      type: "object",
      properties: {
        token: { type: "string", minLength: 1, maxLength: 4096 },
        t: { type: "number", minimum: 0, maximum: 30000 },
        dark: { type: "boolean" },
      },
      required: ["token", "t"],
      additionalProperties: true,
    },
  },
  answer: {
    body: {
      type: "object",
      properties: {
        token: { type: "string", minLength: 1, maxLength: 4096 },
        answer: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            t: { type: "number" },
            pt: { type: "string", maxLength: 16 },
            trusted: { type: "boolean" },
            path: {
              type: "array",
              maxItems: 120,
              items: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: { type: "number" },
              },
            },
          },
          additionalProperties: true,
        },
      },
      required: ["token"],
      additionalProperties: true,
    },
  },
  verify: {
    body: {
      type: "object",
      properties: {
        token: { type: "string", minLength: 1, maxLength: 4096 },
        userId: { type: "string", minLength: 15, maxLength: 25, pattern: "^\\d+$" },
        guildId: { type: "string", minLength: 15, maxLength: 25, pattern: "^\\d+$" },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
};

function makeLimiter(max, windowMs, now = Date.now, maxKeys = 50_000) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= t) {
      if (hits.size >= maxKeys) {
        for (const [candidate, value] of hits) {
          if (value.reset <= t) hits.delete(candidate);
        }
      }
      if (hits.size >= maxKeys) return false;
      hits.set(key, { n: 1, reset: t + windowMs });
      return true;
    }
    entry.n += 1;
    return entry.n <= max;
  };
}

function requestFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] * 100) / 100;
}

function buildMetrics() {
  const counters = {
    challenge_created: 0,
    challenge_success: 0,
    challenge_failure: 0,
    challenge_replay: 0,
  };
  const latency = new Map();
  return {
    counters,
    observe(route, durationMs) {
      const samples = latency.get(route) || [];
      samples.push(durationMs);
      if (samples.length > MAX_METRIC_SAMPLES) samples.splice(0, samples.length - MAX_METRIC_SAMPLES);
      latency.set(route, samples);
    },
    snapshot() {
      return {
        counters: { ...counters },
        latency_ms: Object.fromEntries([...latency.entries()].map(([route, samples]) => [
          route,
          { count: samples.length, p50: quantile(samples, 0.50), p95: quantile(samples, 0.95), p99: quantile(samples, 0.99) },
        ])),
      };
    },
  };
}

export async function buildServer(config = loadConfig(), overrides = {}) {
  let store = overrides.store;
  if (!store) {
    if (config.databaseUrl) {
      const pg = await import("pg");
      const pool = new pg.default.Pool({
        connectionString: config.databaseUrl,
        max: config.pgPoolMax ?? 5,
        connectionTimeoutMillis: config.dbConnectTimeoutMs ?? 3000,
        query_timeout: config.dbQueryTimeoutMs ?? 5000,
        statement_timeout: config.dbQueryTimeoutMs ?? 5000,
        idleTimeoutMillis: 30_000,
        allowExitOnIdle: false,
      });
      store = new PgStore(pool);
      try {
        await store.ready;
      } catch (error) {
        await store.close().catch(() => {});
        throw new Error("PostgreSQL replay store initialization failed", { cause: error });
      }
    } else {
      if (config.production) throw new Error("PostgreSQL replay storage is required in production");
      store = new MemoryStore(overrides.now ?? Date.now);
    }
  }

  const previousSigningKeys = config.previousSigningKeys || [];
  const orbit = createOrbit({
    signingKey: config.signingKey,
    signingKeyId: config.signingKeyId || "k1",
    previousSigningKeys,
    store,
    minBehavior: config.minBehavior,
    now: overrides.now,
  });

  const app = Fastify({
    logger: overrides.logger ?? {
      level: config.logLevel || "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
      serializers: {
        req(request) {
          return { method: request.method, route: request.routeOptions?.url || "unmatched" };
        },
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: MAX_BODY_BYTES,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
  });
  const metrics = buildMetrics();
  const clientLimit = makeLimiter(40, 60_000, overrides.now);
  const tokenLimit = makeLimiter(8, 60_000, overrides.now);
  const frameClientLimit = makeLimiter(1500, 60_000, overrides.now);
  const frameLimit = makeLimiter(1200, 60_000, overrides.now);
  const serverLimit = makeLimiter(600, 60_000, overrides.now);
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(publicDir, file)));
    return cache.get(file);
  };

  const siteSecrets = [config.siteSecret, ...(config.previousSiteSecrets || [])];
  function authed(req) {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
    const supplied = authorization.slice(7);
    return siteSecrets.reduce((matched, secret) => safeEqual(supplied, secret) || matched, false);
  }

  function widgetOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin || !config.publicOrigin) return true;
    return origin === config.publicOrigin;
  }

  app.setErrorHandler((error, req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;
    if (status >= 500) req.log.error({ requestId: req.id, status }, "request failed");
    else req.log.warn({ requestId: req.id, status }, "request rejected");
    const reason = status === 429 ? "rate_limited" : status === 413 ? "payload_too_large" : status >= 500 ? "unavailable" : "invalid";
    return reply.code(status).send({ ok: false, reason });
  });

  app.addHook("onRequest", async (req) => {
    req.orbitStartedAt = performance.now();
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url;
    if (route) metrics.observe(route, Math.max(0, performance.now() - req.orbitStartedAt));
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("X-DNS-Prefetch-Control", "off");
    reply.header("X-Permitted-Cross-Domain-Policies", "none");
    reply.header("X-Download-Options", "noopen");
    if (config.production) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    reply.header("X-Request-Id", req.id);
    const route = req.routeOptions?.url || "";
    if (route === "/widget/embed.js" || route === "/widget/frame.js" || route.startsWith("/lib/")) {
      reply.header("Cache-Control", "public, max-age=3600");
    } else {
      reply.header("Cache-Control", "no-store");
    }
    reply.header("Vary", "Origin");
  });

  app.addHook("onClose", async () => {
    if (typeof store.close === "function") await store.close();
  });

  const liveSchema = {
    response: {
      200: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  };

  app.get("/health", { schema: liveSchema }, async () => ({ ok: true }));
  app.get("/health/live", { schema: liveSchema }, async () => ({ ok: true }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      if (typeof store.healthCheck === "function") await store.healthCheck();
      return { ok: true, dependencies: { replayStore: "up" } };
    } catch {
      return reply.code(503).send({ ok: false, dependencies: { replayStore: "down" } });
    }
  });

  for (const [route, [file, type]] of Object.entries(STATIC)) {
    app.get(route, async (req, reply) => {
      reply.type(type);
      if (route === "/widget/frame") {
        const ancestors = config.allowedOrigins.length ? config.allowedOrigins.join(" ") : "'none'";
        reply.header(
          "Content-Security-Policy",
          "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; " +
          "script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:; " +
          "font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; " +
          "frame-ancestors " + ancestors,
        );
        reply.header("Cache-Control", "no-store");
        reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      } else {
        reply.header("Cache-Control", route.endsWith(".js") ? "public, max-age=3600" : "no-cache");
      }
      return load(file);
    });
  }

  // Backend-only endpoints. Previous site secrets are accepted only during an explicit rotation window.
  app.post("/v1/session", { schema: schemas.session }, async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ ok: false, reason: "unauthorized" });
    if (!serverLimit("srv")) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const result = await orbit.createSession(req.body || {});
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.post("/v1/siteverify", { schema: schemas.verify }, async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ success: false, reason: "unauthorized" });
    if (!serverLimit("srv")) return reply.code(429).send({ success: false, reason: "rate_limited" });
    const result = await orbit.siteverify(req.body || {});
    return reply.code(200).send(result);
  });

  // The widget runs inside an Orbit-origin iframe. Embedding pages are constrained by CSP frame-ancestors;
  // API requests themselves remain same-origin with the iframe and never enable wildcard CORS.
  app.post("/v1/challenge/new", { schema: schemas.challengeNew }, async (req, reply) => {
    if (!widgetOriginAllowed(req)) return reply.code(403).send({ ok: false, reason: "invalid" });
    if (!clientLimit("n:" + req.ip)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const result = await orbit.startChallenge(req.body || {});
    if (result.ok) {
      metrics.counters.challenge_created += 1;
      return reply.code(200).send(result);
    }
    req.log.info({ requestId: req.id, reason: result.reason }, "orbit session rejected");
    return reply.code(400).send({ ok: false, reason: "invalid" });
  });

  app.post("/v1/challenge/frame", { schema: schemas.frame }, async (req, reply) => {
    if (!widgetOriginAllowed(req)) return reply.code(403).send({ ok: false, reason: "invalid" });
    if (!frameClientLimit("f:" + req.ip)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const token = req.body && req.body.token;
    if (!frameLimit("f:" + requestFingerprint(token || req.ip))) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const result = await orbit.renderFrame(req.body || {});
    if (!result.ok || !Buffer.isBuffer(result.png) || result.png.length > MAX_FRAME_BYTES) {
      req.log.warn({ requestId: req.id }, "orbit frame rejected");
      return reply.code(400).send({ ok: false, reason: "invalid" });
    }
    reply.type("image/png");
    reply.header("Content-Length", result.png.length);
    reply.header("Cache-Control", "no-store");
    return result.png;
  });

  app.post("/v1/challenge/answer", { schema: schemas.answer }, async (req, reply) => {
    if (!widgetOriginAllowed(req)) return reply.code(403).send({ ok: false, reason: "invalid" });
    if (!clientLimit("a:" + req.ip)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const token = req.body && req.body.token;
    if (!tokenLimit("t:" + requestFingerprint(token || req.ip))) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const result = await orbit.submitAnswer(req.body || {});
    if (!result.ok) {
      metrics.counters.challenge_failure += 1;
      if (result.reason === "replay") metrics.counters.challenge_replay += 1;
      req.log.info({ requestId: req.id, reason: result.reason, detail: result.detail }, "orbit answer rejected");
      return reply.code(200).send({ ok: false, reason: result.reason === "failed" ? "failed" : "invalid" });
    }
    if (result.done) metrics.counters.challenge_success += 1;
    return reply.code(200).send(result);
  });

  if (config.metricsEnabled) {
    app.get("/metrics", async (req, reply) => {
      if (!authed(req)) return reply.code(401).send({ ok: false, reason: "unauthorized" });
      reply.header("Cache-Control", "no-store");
      return metrics.snapshot();
    });
  }

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = await buildServer(config, { logger: { level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] } });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "graceful shutdown started");
    const forceClose = setTimeout(() => {
      app.log.error({ signal }, "graceful shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceClose.unref();
    try {
      await app.close();
      clearTimeout(forceClose);
      app.log.info({ signal }, "graceful shutdown complete");
    } catch (error) {
      app.log.error({ signal }, "graceful shutdown failed");
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
