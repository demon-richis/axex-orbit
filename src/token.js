import crypto from "node:crypto";
const b64u=(b)=>Buffer.from(b).toString("base64url");
function mac(body,key){return crypto.createHmac("sha256",key).update("orbit.v1."+body).digest("base64url");}
export function sign(payload,key){const body=b64u(JSON.stringify(payload));return body+"."+mac(body,key);}
export function verify(token,keyOrKeyring,expectedType,now){
  if(typeof token!=="string"||token.length>4096)return{ok:false,reason:"malformed"};
  const parts=token.split("."); if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]+$/.test(parts[1]))return{ok:false,reason:"malformed"};
  let payload; try{const decoded=Buffer.from(parts[0],"base64url");if(!decoded.length||b64u(decoded)!==parts[0])return{ok:false,reason:"malformed"};payload=JSON.parse(decoded.toString("utf8"));}catch{return{ok:false,reason:"malformed"}}
  if(!payload||typeof payload!=="object"||Array.isArray(payload))return{ok:false,reason:"malformed"};
  const candidates=typeof keyOrKeyring==="string"?[{id:null,key:keyOrKeyring}]:Array.isArray(keyOrKeyring)?keyOrKeyring.filter(e=>e&&typeof e.key==="string"&&(!payload.kid||e.id===payload.kid)):[]; 
  let valid=false,keyId=null; const got=Buffer.from(parts[1]);
  for(const c of candidates){const expected=Buffer.from(mac(parts[0],c.key));const matches=expected.length===got.length&&crypto.timingSafeEqual(expected,got);if(matches){valid=true;keyId=c.id??null;}}
  if(!valid)return{ok:false,reason:"bad_signature"};
  if(payload.typ!==expectedType)return{ok:false,reason:"wrong_type"};
  if(!Number.isSafeInteger(payload.exp)||payload.exp<0||now>=payload.exp)return{ok:false,reason:"expired"};
  return{ok:true,payload,keyId};
}
export function randomId(bytes=16){if(!Number.isSafeInteger(bytes)||bytes<8||bytes>64)throw new RangeError("randomId bytes must be between 8 and 64");return crypto.randomBytes(bytes).toString("base64url");}
export function deriveSeed(key,cid,round){return crypto.createHmac("sha256",key).update(`seed:${cid}:${round}`).digest("hex");}
export function safeEqual(a,b){const x=crypto.createHash("sha256").update(String(a)).digest(),y=crypto.createHash("sha256").update(String(b)).digest();return crypto.timingSafeEqual(x,y);}
