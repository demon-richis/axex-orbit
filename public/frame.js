import { objectPosition } from "/lib/scene.js";

const TEXT = {
  idle: ["Verify you are human", ""],
  loading: ["Verifying...", ""],
  success: ["Success!", ""],
  fail: ["Verification failed", "Click to try again"],
  cancelled: ["Verification cancelled", "Click to try again"],
  error: ["Could not connect", "Click to retry"],
  round: (a, b) => `Round ${a} of ${b}`,
};
const PHASE = [["Remember the", "glowing ball"], ["Keep your eyes on", "that ball"], ["Tap the ball that", "was glowing"]];

const params = new URLSearchParams(location.hash.slice(1));
const parentOrigin = params.get("origin") || "";
const themeParam = params.get("theme") || "light";
function resolveTheme() {
  if (themeParam === "dark") return "dark";
  if (themeParam === "auto") {
    try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch { return "light"; }
  }
  return "light";
}
const theme = resolveTheme();
try { document.documentElement.setAttribute("data-theme", theme); } catch { /* ignore */ }
const dark = theme === "dark";
const PAL = dark
  ? { a: "#8eaaff", b: "#3c63e6", ghost: "rgba(110,140,255,.2)", grid: "rgba(174,190,255,.07)", spark: "rgba(195,208,255,.56)", orbit: "rgba(142,170,255,.24)", signal: "#71e1ff", ring: "rgba(255,255,255,.07)", shadow: "rgba(0,0,0,.4)", ok: "#30d158", bad: "#ff453a" }
  : { a: "#7fa0ff", b: "#2f5be0", ghost: "rgba(47,91,224,.14)", grid: "rgba(83,107,161,.1)", spark: "rgba(74,104,171,.46)", orbit: "rgba(49,94,251,.2)", signal: "#008fa8", ring: "rgba(154,163,178,.25)", shadow: "rgba(0,0,0,.12)", ok: "#1e9e5a", bad: "#d93025" };
const AMBER = "#f59e0b";

const $ = (id) => document.getElementById(id);
const el = { box: $("box"), label: $("label"), sub: $("sub"), pop: $("pop"), canvas: $("c"), instrSmall: $("instrSmall"), instr: $("instr"), rounds: $("rounds"), bar: $("bar"), help: $("help"), close: $("close") };
const ctx = el.canvas.getContext("2d");
const r1 = (n) => Math.round(n * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notify(msg) {
  if (!parentOrigin) return;
  try { parent.postMessage({ source: "axex-orbit", ...msg }, parentOrigin); } catch { /* ignore */ }
}
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok === false) return null;
  try {
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/* ---------------- inline widget state ---------------- */
let verified = false;
function setInline(state, key) {
  const [a, b] = TEXT[key || state] || ["", ""];
  el.box.setAttribute("data-state", state);
  el.box.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  el.box.setAttribute("aria-label", b ? `${a}. ${b}` : a);
  el.label.textContent = a;
  el.sub.textContent = b;
  verified = state === "success";
}
function setHeader(tone, small, big) {
  el.pop.setAttribute("data-tone", tone);
  el.instrSmall.textContent = small;
  el.instr.textContent = big;
  el.pop.setAttribute("aria-label", `${small}. ${big}`);
}
function enterPop() {
  setHeader("blue", "One moment", "Loading...");
  el.pop.setAttribute("data-view", "play");
  notify({ event: "mode", mode: "pop" });
  return sleep(80).then(() => {
    document.body.classList.add("pop"); // let the parent resize the iframe first
    el.pop.focus?.();
  });
}
function leavePop() {
  document.body.classList.remove("pop");
  el.pop.setAttribute("data-view", "play");
  el.box.focus?.();
  notify({ event: "mode", mode: "inline" });
}

/* ---------------- messages from the embedding page ---------------- */
let sessionResolver = null;
let cancelSession = null;
let cancelRound = null;
window.addEventListener("message", (e) => {
  if (e.source !== parent || e.origin !== parentOrigin) return;
  const d = e.data;
  if (!d || d.target !== "axex-orbit-frame") return;
  if (d.cmd === "cancel") {
    if (cancelRound) cancelRound();
    else if (cancelSession) cancelSession();
    return;
  }
  if (!sessionResolver) return;
  if (d.cmd === "session") { sessionResolver(d.session); sessionResolver = null; }
  else if (d.cmd === "session_error") { sessionResolver(null); sessionResolver = null; }
});
function requestSession() {
  return new Promise((resolve) => {
    sessionResolver = resolve;
    cancelSession = () => {
      if (sessionResolver !== resolve) return;
      sessionResolver = null;
      cancelSession = null;
      resolve({ cancelled: true });
    };
    notify({ event: "request_session" });
    setTimeout(() => {
      if (sessionResolver === resolve) {
        sessionResolver = null;
        cancelSession = null;
        resolve(null);
      }
    }, 10000);
  });
}

/* ---------------- drawing ---------------- */
function fit(scene) {
  const r = el.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (el.canvas.width !== w || el.canvas.height !== h) { el.canvas.width = w; el.canvas.height = h; }
  ctx.setTransform(w / scene.W, 0, 0, h / scene.H, 0, 0);
}
function ball(x, y, r, c1, c2, alpha = 1) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 1;
}
function ring(x, y, r, color, w, dash) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = w;
  ctx.strokeStyle = color;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}
function pill(text, x, y, bg, fg, scene) {
  const w = text.length * 6.8 + 18;
  const px = Math.min(Math.max(x - w / 2, 4), scene.W - w - 4);
  const py = Math.min(Math.max(y, 4), scene.H - 26);
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, w, 22, 11); else ctx.rect(px, py, w, 22);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = "700 10px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, px + w / 2, py + 11.5);
}

function drawBackdrop(scene, t) {
  const cx = scene.W / 2, cy = scene.H / 2;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = PAL.grid;
  for (let x = 30; x < scene.W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, scene.H); ctx.stroke(); }
  for (let y = 30; y < scene.H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(scene.W, y); ctx.stroke(); }

  ctx.translate(cx, cy);
  ctx.rotate((t / 10000) % (Math.PI * 2));
  ctx.setLineDash([2, 8]);
  ctx.strokeStyle = PAL.orbit;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(0, 0, 132, 78, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.rotate(Math.PI / 3);
  ctx.beginPath(); ctx.ellipse(0, 0, 132, 78, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < 22; i++) {
    const x = ((i * 83 + 17) % scene.W) - cx;
    const y = ((i * 47 + 29) % scene.H) - cy;
    const pulse = 0.45 + 0.35 * Math.sin(t / 420 + i * 1.7);
    ctx.globalAlpha = Math.max(0.12, pulse);
    ctx.fillStyle = PAL.spark;
    ctx.beginPath();
    ctx.arc(x, y, i % 5 === 0 ? 1.5 : 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.rotate(-Math.PI / 3 - (t / 10000) % (Math.PI * 2));
  for (let i = 0; i < 3; i++) {
    const a = t / (1800 + i * 260) + i * 2.1;
    const x = Math.cos(a) * (106 + i * 13), y = Math.sin(a) * (58 + i * 9);
    ctx.fillStyle = i === 1 ? AMBER : PAL.signal;
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.moveTo(x, y - 3); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 3); ctx.lineTo(x - 3, y); ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// o.reveal = { tapped:[x,y]|null, ok:boolean } draws the verdict markers on the frozen scene.
function drawScene(scene, t, o = {}) {
  ctx.clearRect(0, 0, scene.W, scene.H);
  drawBackdrop(scene, t);
  for (const rr of [60, 115]) ring(scene.W / 2, scene.H / 2, rr, PAL.ring, 1);
  const moving = t > scene.highlightMs && t < scene.highlightMs + scene.shuffleMs;
  scene.objects.forEach((ob) => {
    const [x, y] = objectPosition(scene, ob, t);
    ctx.beginPath();
    ctx.ellipse(x, y + scene.R + 3, scene.R * 0.7, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = PAL.shadow;
    ctx.fill();
    if (moving) for (let k = 2; k >= 1; k--) {
      const [tx, ty] = objectPosition(scene, ob, t - k * 45);
      ball(tx, ty, scene.R * (1 - k * 0.12), PAL.a, PAL.b, 0.13);
    }
    ball(x, y, scene.R, PAL.a, PAL.b);
  });
  const [tx, ty] = objectPosition(scene, scene.objects[scene.target], t);
  if (t < scene.highlightMs) {
    const pulse = 5 + 2.5 * Math.sin(t / 140);
    ball(tx, ty, scene.R + 10, AMBER, AMBER, 0.22);
    ball(tx, ty, scene.R, "#ffd27a", AMBER);
    ring(tx, ty, scene.R + pulse, AMBER, 3);
    pill("REMEMBER", tx, ty - scene.R - 32, AMBER, "#1f2937", scene);
  }
  if (o.reveal) {
    ring(tx, ty, scene.R + 8, PAL.ok, 3, o.reveal.ok ? null : [5, 4]);
    pill(o.reveal.ok ? "CORRECT" : "THIS ONE", tx, ty + scene.R + 14, PAL.ok, "#fff", scene);
    if (!o.reveal.ok && o.reveal.tapped) ring(o.reveal.tapped[0], o.reveal.tapped[1], scene.R + 8, PAL.bad, 3);
  }
}

/* ---------------- one round ---------------- */
function runRound(data) {
  return new Promise((resolve) => {
    const { scene } = data;
    const answerStart = scene.highlightMs + scene.shuffleMs;
    const end = answerStart + scene.windowMs;
    const t0 = performance.now();
    const now = () => performance.now() - t0;
    let path = [];
    let done = false;
    let raf = 0;
    let lastPhase = -1;

    const toLogical = (e) => {
      const r = el.canvas.getBoundingClientRect();
      const s = r.width / scene.W;
      return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
    };
    const sample = (e) => {
      const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      for (const ev of list && list.length ? list : [e]) {
        const [x, y] = toLogical(ev);
        path.push([r1(x), r1(y), r1(now())]);
      }
      if (path.length > 200) path = path.slice(-120);
    };
    const cleanup = () => {
      done = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", sample);
      el.canvas.removeEventListener("pointerdown", onDown);
      cancelRound = null;
    };
    function onDown(e) {
      if (done) return;
      const t = now();
      if (t < answerStart) return; // ignore taps before the balls stop
      sample(e);
      const [x, y] = toLogical(e);
      cleanup();
      drawScene(scene, t);
      resolve({ tapped: [x, y], answer: { x: r1(x), y: r1(y), t: r1(t), pt: e.pointerType || "mouse", trusted: e.isTrusted === true, path: path.slice(-80) } });
    }
    cancelRound = () => { if (!done) { cleanup(); resolve({ cancelled: true }); } };

    function frame() {
      const t = now();
      fit(scene);
      drawScene(scene, t);
      const phase = t < scene.highlightMs ? 0 : t < answerStart ? 1 : 2;
      if (phase !== lastPhase) {
        lastPhase = phase;
        setHeader("blue", PHASE[phase][0], PHASE[phase][1]);
        el.pop.setAttribute("data-phase", String(phase));
      }
      const frac = phase === 0 ? 1 - t / scene.highlightMs : phase === 1 ? (t - scene.highlightMs) / scene.shuffleMs : 1 - (t - answerStart) / scene.windowMs;
      el.bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
      if (t > end) {
        cleanup();
        resolve({ tapped: null, answer: { x: 0, y: 0, t: r1(end + 1), pt: "mouse", trusted: false, path: [] } });
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    document.addEventListener("pointermove", sample);
    el.canvas.addEventListener("pointerdown", onDown);
    frame();
  });
}

async function verdict(scene, tapped, ok, last) {
  fit(scene);
  el.bar.style.width = "100%";
  if (ok && last) {
    setHeader("green", "All rounds correct", "You are verified");
    el.pop.setAttribute("data-view", "done");
    await sleep(1000);
    return;
  }
  drawScene(scene, scene.highlightMs + scene.shuffleMs, { reveal: { tapped, ok } });
  if (ok) { setHeader("green", "Correct", "Next round"); await sleep(900); }
  else { setHeader("red", "Wrong ball.", "Verification failed"); await sleep(1700); }
}

/* ---------------- main flow ---------------- */
let busy = false;
async function playRounds(first) {
  let data = first;
  while (true) {
    el.rounds.textContent = TEXT.round(data.round, data.rounds);
    const r = await runRound(data);
    if (r.cancelled) { leavePop(); setInline("fail", "cancelled"); notify({ event: "fail", reason: "cancelled" }); return; }
    let res;
    try { res = await api("/v1/challenge/answer", { token: data.token, answer: r.answer }); } catch { res = null; }
    if (!res) { leavePop(); setInline("error"); notify({ event: "error", reason: "network" }); return; }
    if (!res.ok) { await verdict(data.scene, r.tapped, false, false); leavePop(); setInline("fail"); notify({ event: "fail", reason: res.reason }); return; }
    await verdict(data.scene, r.tapped, true, res.done === true);
    if (res.done) { leavePop(); setInline("success"); notify({ event: "success", token: res.passToken }); return; }
    data = res;
  }
}

async function start() {
  if (busy || verified) return;
  busy = true;
  try {
    setInline("loading");
    const session = await requestSession();
    if (!session) { setInline("error"); notify({ event: "error", reason: "session" }); return; }
    if (session.cancelled) { setInline("fail", "cancelled"); notify({ event: "fail", reason: "cancelled" }); return; }
    let data;
    try { data = await api("/v1/challenge/new", { session }); } catch { data = null; }
    if (!data || !data.ok) { setInline("error"); notify({ event: "error", reason: (data && data.reason) || "network" }); return; }
    await enterPop();
    await playRounds(data);
  } finally {
    busy = false;
  }
}

el.box.addEventListener("click", start);
el.box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { if (e.preventDefault) e.preventDefault(); start(); } });
el.close.addEventListener("click", () => { if (cancelRound) cancelRound(); });
el.help.addEventListener("click", () => notify({ event: "help" }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cancelRound) cancelRound(); });
setInline("idle");
notify({ event: "ready" });
