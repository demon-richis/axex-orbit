import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { sign, verify } from "../src/token.js";

const production = {
  NODE_ENV:"production",
  ORBIT_SIGNING_KEY:"s".repeat(48),
  ORBIT_SIGNING_KEY_ID:"k2",
  ORBIT_SITE_SECRET:"p".repeat(48),
  ORBIT_PUBLIC_URL:"https://orbit.example",
  ALLOWED_ORIGINS:"https://portal.example",
  DATABASE_URL:"postgresql://orbit:password@db.example:5432/orbit?sslmode=require",
};

test("production rejects missing persistence, weak secrets and insecure origins",()=>{
  assert.throws(()=>loadConfig({NODE_ENV:"production"}),/ORBIT_SIGNING_KEY/);
  assert.throws(()=>loadConfig({...production,DATABASE_URL:""}),/DATABASE_URL/);
  assert.throws(()=>loadConfig({...production,ALLOWED_ORIGINS:"http://portal.example"}),/HTTPS/);
  assert.throws(()=>loadConfig({...production,ORBIT_PUBLIC_URL:"https://orbit.example/path"}),/origin only/);
  assert.equal(loadConfig(production).production,true);
});
test("configuration validates numeric and boolean thresholds",()=>{
  assert.throws(()=>loadConfig({PORT:"0"}),/PORT/);
  assert.throws(()=>loadConfig({MIN_BEHAVIOR:"1.2"}),/MIN_BEHAVIOR/);
  assert.throws(()=>loadConfig({TRUST_PROXY:"true"}),/TRUST_PROXY/);
});
test("rotating signing keys preserves old-token verification",()=>{
  const old="old-key-0123456789-abcdefghijklmnopqrstuvwxyz";
  const active="active-key-0123456789-abcdefghijklmnopqrstuv";
  const oldToken=sign({typ:"sess",exp:5000},old);
  const activeToken=sign({typ:"sess",kid:"k2",exp:5000},active);
  const ring=[{id:"k2",key:active},{id:"k1",key:old}];
  assert.equal(verify(oldToken,ring,"sess",1000).keyId,"k1");
  assert.equal(verify(activeToken,ring,"sess",1000).keyId,"k2");
  assert.equal(verify(activeToken,[{id:"k3",key:"wrong-key-0123456789-abcdefghijklmnop"}],"sess",1000).reason,"bad_signature");
});
test("expired and forged tokens fail closed",()=>{
  const key="signing-key-0123456789-abcdefghijklmnopqrstuvwxyz";
  const token=sign({typ:"sess",exp:100},key);
  assert.equal(verify(token,key,"sess",100).reason,"expired");
  const forged=token.slice(0,-1)+(token.endsWith("A")?"B":"A");
  assert.equal(verify(forged,key,"sess",1).reason,"bad_signature");
});
