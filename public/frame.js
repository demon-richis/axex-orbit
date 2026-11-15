import { positionAt } from "/lib/scene.js";

const TEXT = {
  en: { loading: "Loading...", remember: "Remember the glowing ball", track: "Keep your eyes on it...", tap: "Tap the ball you remembered!", ok: "Correct", wrong: "Wrong ball. Verification failed.", err: "Something went wrong. Please retry.", round: "Round", help: "Need help?" },
  hi: { loading: "Load ho raha hai...", remember: "Chamakte hue ball ko yaad rakho", track: "Us par nazar rakho...", tap: "Jo ball yaad tha, use tap karo!", ok: "Sahi", wrong: "Galat ball. Verification fail.", err: "Kuch gadbad hui. Dobara try karo.", round: "Round", help: "Madad chahiye?" },
};

const params = new URLSearchParams(location.hash.slice(1));
const session = params.get("session");
const parentOrigin = params.get("origin") || "";
const lang = TEXT[params.get("lang")] ? params.get("lang") : "en";
const T = TEXT[lang];

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");
const statusEl = $("status");
const overlay = $("overlay");
$("help").textContent = T.help;
document.documentElement.lang = lang === "hi" ? "hi" : "en";

function notify(msg) {
  if (!parentOrigin) return;
  try { parent.postMessage({ source: "axex-orbit", ...msg }, parentOrigin); } catch { /* ignore */ }
}
$("help").addEventListener("click", () => notify({ event: "help" }));

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

function setStatus(t) { statusEl.textContent = t; }
function showOverlay(t) { overlay.style.display = t ? "flex" : "none"; overlay.textContent = t || ""; }

function fitCanvas(scene) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const s = canvas.width / scene.W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  return rect.width / scene.W; // css px per logical px
}

function runRound(data) {
  return new Promise((resolve) => {
    const { scene } = data;
    const scale = fitCanvas(scene);
    const answerStart = scene.highlightMs + scene.shuffleMs;
    const t0 = performance.now();
    let path = [];
    let answered = false;
    let raf = 0;

    const toLogical = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
    };
    const now = () => performance.now() - t0;

    function onMove(e) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const [x, y] = toLogical(ev);
        path.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(now() * 10) / 10]);
      }
      if (path.length > 160) path = path.slice(-120);
    }
    async function onDown(e) {
      if (answered) return;
      const t = now();
      if (t < answerStart) return;
      answered = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      const [x, y] = toLogical(e);
      onMove(e);
      resolve({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, t: Math.round(t * 10) / 10, pt: e.pointerType || "mouse", trusted: e.isTrusted === true, path: path.slice(-80) });
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);

    function frame() {
      const t = now();
      ctx.clearRect(0, 0, scene.W, scene.H);
      const tau = t - scene.highlightMs;
      scene.objects.forEach((o, i) => {
        const [x, y] = positionAt(o, tau);
        ctx.beginPath();
        ctx.arc(x, y, scene.R, 0, Math.PI * 2);
        ctx.fillStyle = "#4b5266";
        ctx.fill();
        if (i === scene.target && t < scene.highlightMs) {
          ctx.lineWidth = 4;
          ctx.strokeStyle = "#ffd24a";
          ctx.shadowColor = "#ffd24a";
          ctx.shadowBlur = 16;
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.fillStyle = "#ffd24a";
          ctx.fill();
        }
      });
      setStatus(t < scene.highlightMs ? T.remember : t < answerStart ? T.track : T.tap);
      if (t > answerStart + scene.windowMs) {
        answered = true;
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerdown", onDown);
        resolve({ x: 0, y: 0, t: answerStart + scene.windowMs + 1, pt: "mouse", trusted: false, path: [] });
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    frame();
  });
}

async function main() {
  if (!session) { setStatus(T.err); notify({ event: "error", reason: "no_session" }); return; }
  setStatus(T.loading);
  let data;
  try { data = await api("/v1/challenge/new", { session }); } catch { data = null; }
  if (!data || !data.ok) { setStatus(T.err); notify({ event: "error", reason: (data && data.reason) || "network" }); return; }

  while (true) {
    $("round").textContent = `${T.round} ${data.round}/${data.rounds}`;
    showOverlay("");
    const answer = await runRound(data);
    let res;
    try { res = await api("/v1/challenge/answer", { token: data.token, answer }); } catch { res = null; }
    if (!res) { setStatus(T.err); notify({ event: "error", reason: "network" }); return; }
    if (!res.ok) {
      setStatus(T.wrong);
      showOverlay(T.wrong);
      notify({ event: "fail", reason: res.reason });
      return;
    }
    if (res.done) {
      setStatus(T.ok);
      showOverlay(T.ok);
      notify({ event: "success", token: res.passToken });
      return;
    }
    setStatus(T.ok);
    data = res;
  }
}
main();
