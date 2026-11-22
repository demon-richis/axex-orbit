import crypto from "node:crypto";

const LOG_LEVELS = new Set(["fatal","error","warn","info","debug","trace","silent"]);
function invalid(name, message) { throw new Error(`Invalid ${name}: ${message}`); }
function secretValue(value, name, production) {
  if (value === undefined || value === "") {
    if (production) invalid(name, "must be explicitly configured in production");
    return crypto.randomBytes(48).toString("base64url");
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) invalid(name, "must contain at least 32 bytes");
  return value;
}
function parseOrigin(value, name, production) {
  let url; try { url = new URL(value); } catch { invalid(name, "must contain a valid origin"); }
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (production && url.protocol !== "https:")) invalid(name, "must be an origin only (HTTPS in production)");
  return url.origin;
}
function parsePreviousSigningKeys(value, activeId) {
  if (!value) return [];
  const entries=value.split(",").map(entry=>{ const i=entry.indexOf(":"); if(i<=0) invalid("ORBIT_PREVIOUS_SIGNING_KEYS","use keyId:secret entries"); const id=entry.slice(0,i).trim(), key=entry.slice(i+1).trim(); if(!/^[A-Za-z0-9_-]{1,32}$/.test(id)||id===activeId) invalid("ORBIT_PREVIOUS_SIGNING_KEYS","key IDs must be unique"); if(Buffer.byteLength(key,"utf8")<32) invalid("ORBIT_PREVIOUS_SIGNING_KEYS","each previous key must contain at least 32 bytes"); return {id,key}; });
  if(entries.length>3||new Set(entries.map(e=>e.id)).size!==entries.length) invalid("ORBIT_PREVIOUS_SIGNING_KEYS","provide at most three unique previous keys");
  return entries;
}
function parsePreviousSiteSecrets(value) {
  if(!value) return [];
  const entries=value.split(",").map(v=>v.trim());
  if(entries.length>3||entries.some(v=>Buffer.byteLength(v,"utf8")<32)||new Set(entries).size!==entries.length) invalid("ORBIT_PREVIOUS_SITE_SECRETS","provide at most three unique secrets of at least 32 bytes");
  return entries;
}
function integer(value,fallback,name,min,max) {
  if(value===undefined||value==="") return fallback;
  if(!/^\d+$/.test(String(value))) invalid(name,"must be an integer");
  const n=Number(value); if(!Number.isSafeInteger(n)||n<min||n>max) invalid(name,`must be between ${min} and ${max}`); return n;
}
function bool01(value,fallback,name) { if(value===undefined||value==="") return fallback; if(value!=="0"&&value!=="1") invalid(name,"must be 0 or 1"); return value==="1"; }

export function loadConfig(env=process.env) {
  const nodeEnv=env.NODE_ENV||"development";
  if(!["development","test","production"].includes(nodeEnv)) invalid("NODE_ENV","must be development, test, or production");
  const production=nodeEnv==="production";
  const signingKeyId=env.ORBIT_SIGNING_KEY_ID||"k1";
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(signingKeyId)) invalid("ORBIT_SIGNING_KEY_ID","must be 1-32 letters, digits, underscores, or hyphens");
  const signingKey=secretValue(env.ORBIT_SIGNING_KEY,"ORBIT_SIGNING_KEY",production);
  const siteSecret=secretValue(env.ORBIT_SITE_SECRET,"ORBIT_SITE_SECRET",production);
  if(signingKey===siteSecret) invalid("ORBIT_SIGNING_KEY / ORBIT_SITE_SECRET","must be different");
  const previousSigningKeys=parsePreviousSigningKeys(env.ORBIT_PREVIOUS_SIGNING_KEYS,signingKeyId);
  const previousSiteSecrets=parsePreviousSiteSecrets(env.ORBIT_PREVIOUS_SITE_SECRETS);
  if(previousSiteSecrets.includes(siteSecret)) invalid("ORBIT_PREVIOUS_SITE_SECRETS","must not repeat the active secret");
  if(previousSigningKeys.some(e=>e.key===signingKey||e.key===siteSecret)) invalid("ORBIT_PREVIOUS_SIGNING_KEYS","must be distinct from active secrets");
  const allowedOrigins=[...new Set((env.ALLOWED_ORIGINS||"").split(",").map(v=>v.trim()).filter(Boolean).map(v=>parseOrigin(v,"ALLOWED_ORIGINS",production)))];
  if(allowedOrigins.length>50) invalid("ALLOWED_ORIGINS","at most 50 origins");
  if(production&&allowedOrigins.length===0) invalid("ALLOWED_ORIGINS","required in production");
  let publicOrigin="";
  if(env.ORBIT_PUBLIC_URL) publicOrigin=parseOrigin(env.ORBIT_PUBLIC_URL.replace(/\/$/,""),"ORBIT_PUBLIC_URL",production);
  else if(production) invalid("ORBIT_PUBLIC_URL","required in production");
  const databaseUrl=env.DATABASE_URL||"";
  if(databaseUrl){ let u; try{u=new URL(databaseUrl);}catch{invalid("DATABASE_URL","must be a valid PostgreSQL URL");} if(!["postgres:","postgresql:"].includes(u.protocol)||!u.hostname) invalid("DATABASE_URL","must use postgres:// or postgresql:// with a host"); }
  else if(production) invalid("DATABASE_URL","required in production");
  const minBehavior=env.MIN_BEHAVIOR===undefined||env.MIN_BEHAVIOR===""?0.5:Number(env.MIN_BEHAVIOR);
  if(!Number.isFinite(minBehavior)||minBehavior<0||minBehavior>1) invalid("MIN_BEHAVIOR","must be between 0 and 1");
  const logLevel=env.LOG_LEVEL||(production?"info":"debug"); if(!LOG_LEVELS.has(logLevel)) invalid("LOG_LEVEL","unsupported log level");
  return {
    nodeEnv,production,port:integer(env.PORT,8787,"PORT",1,65535),signingKey,signingKeyId,previousSigningKeys,siteSecret,previousSiteSecrets,
    allowedOrigins,publicOrigin,databaseUrl,trustProxy:bool01(env.TRUST_PROXY,false,"TRUST_PROXY"),minBehavior,
    metricsEnabled:bool01(env.ORBIT_METRICS_ENABLED,false,"ORBIT_METRICS_ENABLED"),logLevel,
    pgPoolMax:integer(env.PG_POOL_MAX,5,"PG_POOL_MAX",1,20),
    dbConnectTimeoutMs:integer(env.DB_CONNECT_TIMEOUT_MS,3000,"DB_CONNECT_TIMEOUT_MS",100,30000),
    dbQueryTimeoutMs:integer(env.DB_QUERY_TIMEOUT_MS,5000,"DB_QUERY_TIMEOUT_MS",100,30000)
  };
}
