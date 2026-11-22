// Replay registry shared by every application instance when PostgreSQL is enabled.
// The in-memory implementation is intentionally limited to single-instance development/test use.

export class MemoryStore {
  constructor(now = Date.now, { maxEntries = 100_000 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.ops = 0;
  }

  async markUsed(jti, ttlMs) {
    const t = this.now();
    if (++this.ops % 128 === 0 || this.map.size >= this.maxEntries) {
      for (const [key, expiresAt] of this.map) {
        if (expiresAt <= t) this.map.delete(key);
      }
    }

    const expiresAt = this.map.get(jti);
    if (expiresAt && expiresAt > t) return false;
    if (!expiresAt && this.map.size >= this.maxEntries) {
      const error = new Error("replay store capacity reached");
      error.code = "ORBIT_STORE_CAPACITY";
      throw error;
    }
    this.map.set(jti, t + ttlMs);
    return true;
  }

  async healthCheck() {
    return true;
  }

  async close() {}
}

// The table and index are safe to create on every startup; PostgreSQL serializes DDL
// and IF NOT EXISTS makes this an idempotent, backwards-compatible migration.
export class PgStore {
  constructor(pool) {
    this.pool = pool;
    this.ops = 0;
    this.ready = (async () => {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS orbit_used_tokens (jti text PRIMARY KEY, expires_at timestamptz NOT NULL)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS orbit_used_tokens_exp ON orbit_used_tokens (expires_at)",
      );
    })();
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch(() => {});
    }, 15 * 60_000);
    this.cleanupTimer.unref?.();
  }

  async cleanupExpired(batchSize = 1000) {
    await this.ready;
    await this.pool.query(
      "DELETE FROM orbit_used_tokens WHERE ctid IN (" +
      "SELECT ctid FROM orbit_used_tokens WHERE expires_at < now() ORDER BY expires_at LIMIT $1)",
      [batchSize],
    );
  }

  async markUsed(jti, ttlMs) {
    await this.ready;
    if (typeof jti !== "string" || !jti || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("invalid replay-store operation");
    }
    if (++this.ops % 250 === 0) {
      // Cleanup is batched, fire-and-forget, and never blocks token validation.
      this.cleanupExpired().catch(() => {});
    }
    const result = await this.pool.query(
      "INSERT INTO orbit_used_tokens (jti, expires_at) VALUES ($1, now() + ($2 || ' milliseconds')::interval) " +
      "ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at " +
      "WHERE orbit_used_tokens.expires_at < now() RETURNING jti",
      [jti, String(ttlMs)],
    );
    return result.rowCount === 1;
  }

  async healthCheck() {
    await this.ready;
    await this.pool.query("SELECT 1");
    return true;
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await this.pool.end();
  }
}
