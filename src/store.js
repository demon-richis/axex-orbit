// One-time-use registry for token ids (replay protection).
// markUsed(jti, ttlMs) -> true if first use, false if already used.

export class MemoryStore {
  constructor(now = Date.now) {
    this.now = now;
    this.map = new Map();
    this.ops = 0;
  }
  async markUsed(jti, ttlMs) {
    const t = this.now();
    if (++this.ops % 500 === 0) {
      for (const [k, exp] of this.map) if (exp <= t) this.map.delete(k);
    }
    const exp = this.map.get(jti);
    if (exp && exp > t) return false;
    this.map.set(jti, t + ttlMs);
    return true;
  }
}

// Postgres adapter (works with Neon). Table is created automatically.
export class PgStore {
  constructor(pool) {
    this.pool = pool;
    this.ready = pool.query(
      "CREATE TABLE IF NOT EXISTS orbit_used_tokens (jti text PRIMARY KEY, expires_at timestamptz NOT NULL); CREATE INDEX IF NOT EXISTS orbit_used_tokens_exp ON orbit_used_tokens (expires_at);"
    );
    this.ops = 0;
  }
  async markUsed(jti, ttlMs) {
    await this.ready;
    if (++this.ops % 200 === 0) this.pool.query("DELETE FROM orbit_used_tokens WHERE expires_at < now()").catch(() => {});
    const r = await this.pool.query(
      "INSERT INTO orbit_used_tokens (jti, expires_at) VALUES ($1, now() + ($2 || ' milliseconds')::interval) ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at WHERE orbit_used_tokens.expires_at < now() RETURNING jti",
      [jti, String(ttlMs)]
    );
    return r.rowCount === 1;
  }
}
