import test from "node:test";
import assert from "node:assert/strict";
import { sign, verify } from "../src/token.js";
import { KEY } from "./helpers.js";

test("valid token verifies", () => {
  const t = sign({ typ: "sess", exp: 2000 }, KEY);
  assert.equal(verify(t, KEY, "sess", 1000).ok, true);
});
test("tampered payload or signature is rejected", () => {
  const t = sign({ typ: "sess", exp: 2000, uid: "1" }, KEY);
  const [b, s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ typ: "sess", exp: 2000, uid: "2" })).toString("base64url");
  assert.equal(verify(forged + "." + s, KEY, "sess", 1000).reason, "bad_signature");
  assert.equal(verify(b + "." + s.slice(0, -2) + "xx", KEY, "sess", 1000).reason, "bad_signature");
});
test("wrong key, wrong type, expired, garbage", () => {
  const t = sign({ typ: "sess", exp: 2000 }, KEY);
  assert.equal(verify(t, KEY + "x", "sess", 1000).reason, "bad_signature");
  assert.equal(verify(t, KEY, "pass", 1000).reason, "wrong_type");
  assert.equal(verify(t, KEY, "sess", 3000).reason, "expired");
  assert.equal(verify("nope", KEY, "sess", 1000).reason, "malformed");
  assert.equal(verify(null, KEY, "sess", 1000).reason, "malformed");
});
