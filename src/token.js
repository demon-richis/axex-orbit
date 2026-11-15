import crypto from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");

function mac(body, key) {
  return crypto.createHmac("sha256", key).update("orbit.v1." + body).digest("base64url");
}

export function sign(payload, key) {
  const body = b64u(JSON.stringify(payload));
  return body + "." + mac(body, key);
}

export function verify(token, key, expectedType, now) {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  const expected = Buffer.from(mac(body, key));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { ok: false, reason: "bad_signature" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.typ !== expectedType) return { ok: false, reason: "wrong_type" };
  if (typeof payload.exp !== "number" || now > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function deriveSeed(key, cid, round) {
  return crypto.createHmac("sha256", key).update(`seed:${cid}:${round}`).digest("hex");
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
