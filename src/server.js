import Fastify from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOrbit } from "./orbit.js";
import { loadConfig } from "./config.js";
import { MemoryStore, PgStore } from "./store.js";
import { safeEqual } from "./token.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

const STATIC = {
  "/widget/frame": ["frame.html", "text/html; charset=utf-8"],
  "/widget/frame.js": ["frame.js", "text/javascript; charset=utf-8"],
  "/widget/embed.js": ["embed.js", "text/javascript; charset=utf-8"],
  "/lib/scene.js": [path.join("..", "src", "scene.js"), "text/javascript; charset=utf-8"],
  "/lib/prng.js": [path.join("..", "src", "prng.js"), "text/javascript; charset=utf-8"],
};

// Small fixed-window limiter. Keyed by whatever the caller passes (ip or secret-hash).
function makeLimiter(max, windowMs, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const e = hits.get(key);
    if (!e || e.reset <= t) {
      hits.set(key, { n: 1, reset: t + windowMs });
      if (hits.size > 50000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      return true;
    }
    return ++e.n <= max;
  };
}

function requestFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

export async function buildServer(config = loadConfig(), overrides = {}) {
  let store = overrides.store;
  if (!store) {
    if (config.databaseUrl) {
      const pg = await import("pg");
      store = new PgStore(new pg.default.Pool({ connectionString: config.databaseUrl, max: 5 }));
    } else {
      store = new MemoryStore();
    }
  }
  const orbit = createOrbit({ signingKey: config.signingKey, store, minBehavior: config.minBehavior, now: overrides.now });
  const app = Fastify({ logger: overrides.logger ?? false, trustProxy: config.trustProxy, bodyLimit: 64 * 1024 });
  const clientLimit = makeLimiter(40, 60_000);
  const tokenLimit = makeLimiter(8, 60_000);
  const frameClientLimit = makeLimiter(900, 60_000);
  const frameLimit = makeLimiter(600, 60_000);
  const serverLimit = makeLimiter(600, 60_000);

  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(publicDir, file)));
    return cache.get(file);
  };

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("X-DNS-Prefetch-Control", "off");
    reply.header("Cache-Control", "no-store");
  });

  const authed = (req) => {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") && safeEqual(h.slice(7), config.siteSecret);
  };

  app.get("/health", async () => ({ ok: true }));

  for (const [route, [file, type]] of Object.entries(STATIC)) {
    app.get(route, async (req, reply) => {
      reply.type(type);
      if (route === "/widget/frame") {
        const ancestors = config.allowedOrigins.length ? config.allowedOrigins.join(" ") : "'none'";
        reply.header("Content-Security-Policy", `default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors ${ancestors}`);
      }
      return load(file);
    });
  }

  // --- portal backend endpoints (secret key) ---
  app.post("/v1/session", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ ok: false, reason: "unauthorized" });
    if (!serverLimit("srv")) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const r = await orbit.createSession(req.body || {});
    return reply.code(r.ok ? 200 : 400).send(r);
  });

  app.post("/v1/siteverify", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ success: false, reason: "unauthorized" });
    if (!serverLimit("srv")) return reply.code(429).send({ success: false, reason: "rate_limited" });
    const r = await orbit.siteverify(req.body || {});
    return reply.code(200).send(r);
  });

  // --- widget (browser) endpoints ---
  app.post("/v1/challenge/new", async (req, reply) => {
    if (!clientLimit("n:" + req.ip)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const r = await orbit.startChallenge(req.body || {});
    return reply.code(r.ok ? 200 : 400).send(r);
  });

  app.post("/v1/challenge/frame", async (req, reply) => {
    if (!frameClientLimit("f:" + req.ip)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const token = req.body && req.body.token;
    if (!frameLimit("f:" + requestFingerprint(token || req.ip))) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const r = await orbit.renderFrame(req.body || {});
    if (!r.ok) return reply.code(400).send({ ok: false, reason: "invalid" });
    reply.type("image/png");
    reply.header("Content-Length", r.png.length);
    return r.png;
  });

  app.post("/v1/challenge/answer", async (req, reply) => {
    if (!clientLimit("a:" + req.ip)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const token = req.body && req.body.token;
    if (!tokenLimit("t:" + requestFingerprint(token || req.ip))) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const r = await orbit.submitAnswer(req.body || {});
    if (!r.ok) {
      req.log.info({ reason: r.reason, detail: r.detail }, "orbit answer rejected");
      // coarse reason only: do not give attackers an oracle
      return reply.code(200).send({ ok: false, reason: r.reason === "failed" ? "failed" : "invalid" });
    }
    return reply.code(200).send(r);
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = await buildServer(config, { logger: true });
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
