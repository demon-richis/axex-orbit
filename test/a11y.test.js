import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const html=fs.readFileSync(new URL("../public/frame.html",import.meta.url),"utf8");
const js=fs.readFileSync(new URL("../public/frame.js",import.meta.url),"utf8");
const embed=fs.readFileSync(new URL("../public/embed.js",import.meta.url),"utf8");
test("widget exposes accessible control states and preferences",()=>{
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/type="button"/);
  assert.match(html,/prefers-reduced-motion/);
  assert.match(html,/prefers-contrast: more/);
  assert.match(js,/e\.key === "Escape"/);
  assert.match(embed,/opts\.onHelp/);
});
