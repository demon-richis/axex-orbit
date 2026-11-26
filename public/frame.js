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

const $ = (id) => document.getElementById(id);
const el = { box: $("box"), label: $("label"), sub: $("sub"), pop: $("pop"), canvas: $("c"), instrSmall: $("instrSmall"), instr: $("instr"), rounds: $("rounds"), bar: $("bar"), help: $("help"), close: $("close") };
const ctx = el.canvas.getContext("2d");
const FRAME_INTERVAL_MS = 50;
const r1 = (n) => Math.round(n * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notify(msg) {
  if (!parentOrigin) return;
  try { parent.postMessage({ source: "axex-orbit", ...msg }, parentOrigin); } catch { /* ignore */ }
}
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok === false) return null;
  try { const data = await res.json(); return data && typeof data === "object" ? data : null; } catch { return null; }
}

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
  return sleep(80).then(() => { document.body.classList.add("pop"); el.pop.focus?.(); });
}
function leavePop() {
  document.body.classList.remove("pop");
  el.pop.setAttribute("data-view", "play");
  el.box.focus?.();
  notify({ event: "mode", mode: "inline" });
}

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
      sessionResolver = null; cancelSession = null; resolve({ cancelled: true });
    };
    notify({ event: "request_session" });
    setTimeout(() => {
      if (sessionResolver === resolve) { sessionResolver = null; cancelSession = null; resolve(null); }
    }, 10000);
  });
}

function fit(timing) {
  const r = el.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  const resized = el.canvas.width !== w || el.canvas.height !== h;
  if (resized) { el.canvas.width = w; el.canvas.height = h; }
  ctx.setTransform(w / timing.W, 0, 0, h / timing.H, 0, 0);
  return resized;
}
async function fetchFrame(token, t) {
  const res = await fetch("/v1/challenge/frame", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, t: r1(t), dark: theme === "dark" }),
  });
  if (!res.ok || !res.headers.get("content-type")?.startsWith("image/png")) return false;
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > 1_000_000) return false;
  const blob = await res.blob();
  if (!blob.size || blob.size > 1_000_000) return false;
  if (typeof createImageBitmap === "function") return await createImageBitmap(blob);
  if (typeof Image !== "function" || !URL.createObjectURL) return false;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ image, close: () => {} });
      image.onerror = () => reject(new Error("frame_decode_failed"));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function runRound(data) {
  return new Promise((resolve) => {
    const timing = data.timing;
    const answerStart = timing.highlightMs + timing.shuffleMs;
    const end = answerStart + timing.windowMs;
    const t0 = performance.now();
    const now = () => performance.now() - t0;
    let path = [], done = false, raf = 0, lastPhase = -1, lastPaint = -Infinity, pending = null, latestImage = null, paintedImage = null, frameErrors = 0;
    const toLogical = (e) => { const r = el.canvas.getBoundingClientRect(); const s = r.width / timing.W; return [(e.clientX - r.left) / s, (e.clientY - r.top) / s]; };
    const sample = (e) => {
      const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      for (const ev of list && list.length ? list : [e]) { const [x, y] = toLogical(ev); path.push([r1(x), r1(y), r1(now())]); }
      if (path.length > 200) path = path.slice(-120);
    };
    const cleanup = () => {
      done = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", sample);
      el.canvas.removeEventListener("pointerdown", onDown);
      latestImage?.close?.();
      latestImage = null;
      cancelRound = null;
    };
    function onDown(e) {
      if (done) return;
      const t = now();
      if (t < answerStart) return;
      sample(e);
      const [x, y] = toLogical(e);
      cleanup();
      resolve({ tapped: [x, y], answer: { x: r1(x), y: r1(y), t: r1(t), pt: e.pointerType || "mouse", trusted: e.isTrusted === true, path: path.slice(-80) } });
    }
    cancelRound = () => { if (!done) { cleanup(); resolve({ cancelled: true }); } };
    function frame() {
      const t = now();
      const phase = t < timing.highlightMs ? 0 : t < answerStart ? 1 : 2;
      if (phase !== lastPhase) { lastPhase = phase; setHeader("blue", PHASE[phase][0], PHASE[phase][1]); el.pop.setAttribute("data-phase", String(phase)); }
      const frac = phase === 0 ? 1 - t / timing.highlightMs : phase === 1 ? (t - timing.highlightMs) / timing.shuffleMs : 1 - (t - answerStart) / timing.windowMs;
      el.bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
      if (t > end) { cleanup(); resolve({ tapped: null, answer: { x: 0, y: 0, t: r1(end + 1), pt: "mouse", trusted: false, path: [] } }); return; }
      if (latestImage) {
        const resized = fit(timing);
        if (resized || latestImage !== paintedImage) {
          ctx.imageSmoothingEnabled = true;
          if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
          ctx.drawImage(latestImage.image || latestImage, 0, 0, timing.W, timing.H);
          paintedImage = latestImage;
        }
      }
      if (!pending && t - lastPaint >= FRAME_INTERVAL_MS) {
        lastPaint = t;
        pending = fetchFrame(data.token, t).then((image) => {
          if (image && typeof image === "object") {
            if (done) image.close?.();
            else { latestImage?.close?.(); latestImage = image; }
          } else if (!image) frameErrors++;
        }).catch(() => { frameErrors++; }).finally(() => { pending = null; });
      }
      if (frameErrors >= 3) { cleanup(); resolve({ network: true }); return; }
      raf = requestAnimationFrame(frame);
    }
    document.addEventListener("pointermove", sample);
    el.canvas.addEventListener("pointerdown", onDown);
    frame();
  });
}

async function verdict(ok, last) {
  el.bar.style.width = "100%";
  if (ok && last) { setHeader("green", "All rounds correct", "You are verified"); el.pop.setAttribute("data-view", "done"); await sleep(1000); return; }
  if (ok) { setHeader("green", "Correct", "Next round"); await sleep(900); }
  else { setHeader("red", "Wrong ball.", "Verification failed"); await sleep(1700); }
}

let busy = false;
async function playRounds(first) {
  let data = first;
  while (true) {
    el.rounds.textContent = TEXT.round(data.round, data.rounds);
    const r = await runRound(data);
    if (r.cancelled) { leavePop(); setInline("fail", "cancelled"); notify({ event: "fail", reason: "cancelled" }); return; }
    if (r.network) { leavePop(); setInline("error"); notify({ event: "error", reason: "network" }); return; }
    let res;
    try { res = await api("/v1/challenge/answer", { token: data.token, answer: r.answer }); } catch { res = null; }
    if (!res) { leavePop(); setInline("error"); notify({ event: "error", reason: "network" }); return; }
    if (!res.ok) { await verdict(false, false); leavePop(); setInline("fail"); notify({ event: "fail", reason: res.reason }); return; }
    await verdict(true, res.done === true);
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
    if (!data || !data.ok || !data.timing) { setInline("error"); notify({ event: "error", reason: (data && data.reason) || "network" }); return; }
    await enterPop();
    await playRounds(data);
  } finally { busy = false; }
}

el.box.addEventListener("click", start);
el.box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { if (e.preventDefault) e.preventDefault(); start(); } });
el.close.addEventListener("click", () => { if (cancelRound) cancelRound(); });
el.help.addEventListener("click", () => notify({ event: "help" }));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cancelRound) { cancelRound(); return; }
  if (e.key !== "Tab" || !document.body.classList.contains("pop")) return;
  const first = el.close, last = el.help;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === el.pop)) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
});
setInline("idle");
notify({ event: "ready" });
