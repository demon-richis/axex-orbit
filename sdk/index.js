// Server-side Node.js SDK. Never expose the site secret to browser code.
export class OrbitClient {
  constructor({ baseUrl, secret, timeoutMs = 4000 }) {
    if (typeof baseUrl !== "string" || !baseUrl) throw new TypeError("baseUrl is required");
    const url = new URL(baseUrl);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!["http:", "https:"].includes(url.protocol) || (url.protocol !== "https:" && !local)) {
      throw new TypeError("baseUrl must use HTTPS (HTTP is allowed only for loopback development)");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new TypeError("baseUrl must be an origin URL without credentials, path, query or fragment");
    }
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new TypeError("secret must contain at least 32 bytes");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new RangeError("timeoutMs must be an integer between 100 and 30000");
    }
    this.baseUrl = url.origin;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }

  async #post(path, body) {
    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Orbit returned an invalid response");
    }
    return result;
  }

  /** Create one single-use attempt. Pass the returned session to the widget. */
  createSession({ userId, guildId, difficulty = "high" }) {
    return this.#post("/v1/session", { userId, guildId, difficulty });
  }

  /** Verify a pass token exactly once and bind it to the expected user and guild. */
  siteverify({ token, userId, guildId }) {
    return this.#post("/v1/siteverify", { token, userId, guildId });
  }
}
