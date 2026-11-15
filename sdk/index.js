// Tiny server-side SDK for the Axex portal backend (Node 18+). Never use these in the browser.
export class OrbitClient {
  constructor({ baseUrl, secret, timeoutMs = 4000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }
  async #post(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + this.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return res.json();
  }
  /** Start one attempt. Returns { ok, session }; pass `session` to the widget. */
  createSession({ userId, guildId, difficulty = "high" }) {
    return this.#post("/v1/session", { userId, guildId, difficulty });
  }
  /** Verify the pass token returned by the widget. Single use. */
  siteverify({ token, userId, guildId }) {
    return this.#post("/v1/siteverify", { token, userId, guildId });
  }
}
