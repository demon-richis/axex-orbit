export function loadConfig(env = process.env) {
  const signingKey = env.ORBIT_SIGNING_KEY || "";
  const siteSecret = env.ORBIT_SITE_SECRET || "";
  const production = env.NODE_ENV === "production";
  if (production && (signingKey.length < 32 || siteSecret.length < 32)) {
    throw new Error("ORBIT_SIGNING_KEY and ORBIT_SITE_SECRET must be set (>= 32 chars) in production");
  }
  return {
    port: Number(env.PORT || 8787),
    signingKey: signingKey || "dev-only-signing-key-change-me-0123456789",
    siteSecret: siteSecret || "dev-only-site-secret-change-me-0123456789",
    allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    databaseUrl: env.DATABASE_URL || "",
    trustProxy: env.TRUST_PROXY === "1",
    minBehavior: env.MIN_BEHAVIOR ? Number(env.MIN_BEHAVIOR) : 0.5,
  };
}
