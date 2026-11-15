// Usage (portal page):
//   <script src="https://YOUR-ORBIT-HOST/widget/embed.js"></script>
//   AxexOrbit.render(document.getElementById("box"), { session, onSuccess(token){}, onFail(){}, onError(r){}, onHelp(){}, lang: "en" });
(function () {
  var script = document.currentScript;
  var base = new URL(script.src).origin;

  function render(el, opts) {
    var iframe = document.createElement("iframe");
    iframe.src = base + "/widget/frame#session=" + encodeURIComponent(opts.session) + "&origin=" + encodeURIComponent(location.origin) + "&lang=" + encodeURIComponent(opts.lang || "en");
    iframe.title = "Axex Orbit verification";
    iframe.style.cssText = "width:100%;max-width:420px;height:420px;border:0;border-radius:12px;display:block;margin:0 auto;";
    iframe.setAttribute("referrerpolicy", "no-referrer");
    function onMessage(e) {
      if (e.origin !== base || e.source !== iframe.contentWindow) return;
      var d = e.data;
      if (!d || d.source !== "axex-orbit") return;
      if (d.event === "success" && opts.onSuccess) opts.onSuccess(d.token);
      else if (d.event === "fail" && opts.onFail) opts.onFail(d.reason);
      else if (d.event === "error" && opts.onError) opts.onError(d.reason);
      else if (d.event === "help" && opts.onHelp) opts.onHelp();
    }
    window.addEventListener("message", onMessage);
    el.appendChild(iframe);
    return { destroy: function () { window.removeEventListener("message", onMessage); iframe.remove(); } };
  }
  window.AxexOrbit = { render: render };
})();
