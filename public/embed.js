// Axex Orbit embed. Looks like a normal captcha: a 300 x 65 "Verify you are human" box.
// Click -> the challenge opens as a centered popup (desktop) or a bottom sheet (phones), then collapses back to the box.
//
//   <script src="https://ORBIT_HOST/widget/embed.js"></script>
//   AxexOrbit.render(document.getElementById("captcha"), {
//     theme: "light",            // "light" (default) | "dark" | "auto"
//     getSession: () => fetch("/api/orbit-session").then(r => r.json()).then(j => j.session), // called on every click/retry
//     onSuccess: (token) => {},  // send token to YOUR backend -> /v1/siteverify
//     onFail: (reason) => {}, onError: (reason) => {}, onHelp: () => {},
//   });
(function () {
  var script = document.currentScript;
  var base = new URL(script.src).origin;

  function injectStyle() {
    if (document.getElementById("axex-orbit-style")) return;
    var s = document.createElement("style");
    s.id = "axex-orbit-style";
    s.textContent =
      "@keyframes axo-pop{from{opacity:0;transform:translate(-50%,-47%) scale(.96)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}" +
      "@keyframes axo-sheet{from{transform:translateY(100%)}to{transform:translateY(0)}}" +
      "@keyframes axo-fade{from{opacity:0}to{opacity:1}}";
    document.head.appendChild(s);
  }

  function inlineStyle(scheme) {
    return "width:100%;height:65px;border:0;border-radius:14px;display:block;box-shadow:0 1px 2px rgba(16,24,40,.08);" + scheme;
  }
  function popStyle(scheme) {
    if (window.innerWidth < 520) {
      return "position:fixed;left:0;bottom:0;width:100vw;height:calc(75vw + 176px + env(safe-area-inset-bottom,0px));max-height:94vh;border:0;border-radius:20px 20px 0 0;z-index:2147483001;box-shadow:0 -10px 40px rgba(0,0,0,.35);animation:axo-sheet .32s cubic-bezier(.2,.8,.2,1);" + scheme;
    }
    return "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:400px;height:464px;max-height:94vh;border:0;border-radius:20px;z-index:2147483001;box-shadow:0 24px 80px rgba(0,0,0,.35);animation:axo-pop .26s cubic-bezier(.2,.8,.2,1);" + scheme;
  }

  function render(el, opts) {
    opts = opts || {};
    injectStyle();
    var theme = opts.theme === "dark" || opts.theme === "auto" ? opts.theme : "light";
    var scheme = theme === "dark" ? "color-scheme:dark;" : theme === "light" ? "color-scheme:light;" : "";

    var wrap = document.createElement("div");
    wrap.style.cssText = "width:300px;max-width:100%;height:65px;position:relative;";
    var iframe = document.createElement("iframe");
    iframe.src = base + "/widget/frame#origin=" + encodeURIComponent(location.origin) + "&theme=" + theme;
    iframe.title = "Axex Orbit verification";
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.style.cssText = inlineStyle(scheme);
    var backdrop = null;
    var popped = false;

    function onResize() { if (popped) iframe.style.cssText = popStyle(scheme); }
    function setMode(mode) {
      if (mode === "pop") {
        popped = true;
        if (!backdrop) {
          backdrop = document.createElement("div");
          backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.38);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);z-index:2147483000;animation:axo-fade .2s ease;";
          backdrop.addEventListener("click", function () { send({ cmd: "cancel" }); });
          document.body.appendChild(backdrop);
        }
        iframe.style.cssText = popStyle(scheme);
      } else {
        popped = false;
        if (backdrop) { backdrop.remove(); backdrop = null; }
        iframe.style.cssText = inlineStyle(scheme);
      }
    }
    function send(msg) {
      if (iframe.contentWindow) iframe.contentWindow.postMessage(Object.assign({ target: "axex-orbit-frame" }, msg), base);
    }
    function provideSession() {
      var first = opts.session;
      opts.session = null; // a session is single-use
      Promise.resolve(first || (opts.getSession ? opts.getSession() : null)).then(function (s) {
        if (!s) throw new Error("no_session");
        send({ cmd: "session", session: s });
      }).catch(function () {
        send({ cmd: "session_error" });
        if (opts.onError) opts.onError("session");
      });
    }
    function onMessage(e) {
      if (e.origin !== base || e.source !== iframe.contentWindow) return;
      var d = e.data;
      if (!d || d.source !== "axex-orbit") return;
      if (d.event === "mode") setMode(d.mode);
      else if (d.event === "request_session") provideSession();
      else if (d.event === "success" && opts.onSuccess) opts.onSuccess(d.token);
      else if (d.event === "fail" && opts.onFail) opts.onFail(d.reason);
      else if (d.event === "error" && opts.onError) opts.onError(d.reason);
      else if (d.event === "help" && opts.onHelp) opts.onHelp();
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("resize", onResize);
    wrap.appendChild(iframe);
    el.appendChild(wrap);
    return {
      destroy: function () {
        window.removeEventListener("message", onMessage);
        window.removeEventListener("resize", onResize);
        if (backdrop) backdrop.remove();
        wrap.remove();
      },
    };
  }
  window.AxexOrbit = { render: render };
})();