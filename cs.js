/* ChipShark shared script: scroll-triggered motion, count-ups, forms, analytics. No libraries. */
(function () {
  const SUPABASE_URL = "https://dgpdfponhxbnhfhmbmjb.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRncGRmcG9uaHhibmhmaG1ibWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwMzc5ODcsImV4cCI6MjEwNjYxMzk4N30.5R9ASFR8eig65JzfNBueXp3NvwHRVtb4wQ2dyH8qhE8";
  // Cloudflare Web Analytics: paste the site token here (it is public, it ships in page source). Empty = off.
  const CF_BEACON_TOKEN = "";

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (CF_BEACON_TOKEN) {
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token: CF_BEACON_TOKEN }));
    document.head.appendChild(s);
  }

  // ---- Count-up numbers: <span data-cs-count="40">0</span>
  function countUp(el) {
    const target = parseFloat(el.dataset.csCount);
    if (reduce || !isFinite(target)) { el.textContent = el.dataset.csCount; return; }
    const t0 = performance.now(), dur = 1100;
    function tick(t) {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---- In-view trigger: anything with [data-cs-in] gets .cs-in once, bars fill, counters run, custom hooks fire.
  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      io.unobserve(el);
      el.classList.add("cs-in");
      el.querySelectorAll("[data-cs-bar]").forEach((b) => { b.style.width = b.dataset.csBar + "%"; });
      el.querySelectorAll("[data-cs-count]").forEach(countUp);
      el.dispatchEvent(new CustomEvent("cs:in"));
    }
  }, { threshold: 0.3 }) : null;

  function prepDraw(root) {
    root.querySelectorAll(".cs-draw").forEach((p) => {
      if (p.getTotalLength) p.style.setProperty("--cs-len", Math.ceil(p.getTotalLength()) + 1);
    });
  }

  function watch(el) {
    prepDraw(el);
    if (io) io.observe(el); else { el.classList.add("cs-in"); el.dispatchEvent(new CustomEvent("cs:in")); }
  }
  document.querySelectorAll("[data-cs-in]").forEach(watch);

  // ---- Country list (one source of truth for every form)
  const COUNTRIES = ["United States","Canada","Mexico","United Kingdom","Germany","France","Netherlands","Italy","Spain","Sweden","Switzerland","India","Singapore","Japan","South Korea","China","Taiwan","Hong Kong","United Arab Emirates","Australia","Israel","Brazil","Other (say where in drop-off)"];
  document.querySelectorAll("select[data-cs-countries]").forEach((sel) => {
    sel.insertAdjacentHTML("beforeend", '<option value="">Pick a country</option>' + COUNTRIES.map((c) => `<option>${c}</option>`).join(""));
  });

  // ---- Form submit helper. build(fd) returns { mpn, qty?, urgency?, notes?, meta? } for this page.
  window.csForm = function (form, opts) {
    const btn = form.querySelector('button[type="submit"]');
    const err = form.querySelector(".cs-err");
    const done = document.getElementById(opts.doneId || "cs-done");
    const label = btn ? btn.textContent : "";
    function fail(msg) { if (err) err.textContent = msg; btn.disabled = false; btn.textContent = label; }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (err) err.textContent = "";
      const fd = new FormData(form);
      if (fd.get("website")) { form.hidden = true; done && done.classList.add("cs-show"); return; }
      const token = fd.get("cf-turnstile-response");
      if (!token) return fail("Tick the human check just above the button, then try again.");
      btn.disabled = true; btn.textContent = "Sending…";
      const extra = opts.build(fd);
      const payload = Object.assign({
        type: opts.type,
        name: fd.get("name"), company: fd.get("company"), email: fd.get("email"),
        phone: fd.get("phone") || null,
        country: fd.get("country") || null, drop_off_location: fd.get("drop_off") || null,
        urgency: fd.get("urgency") || "Standard (24h quote)",
        notes: fd.get("notes") || null,
        turnstile_token: token,
      }, extra);
      try {
        const res = await fetch(SUPABASE_URL + "/functions/v1/rfq-submit", {
          method: "POST",
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          form.hidden = true;
          if (done) { done.classList.add("cs-show"); done.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" }); }
          return;
        }
        let msg = await res.text();
        try { msg = JSON.parse(msg).error || msg; } catch (_) {}
        if (window.turnstile) try { window.turnstile.reset(); } catch (_) {}
        fail(msg + " If it keeps failing, email hello@chipsharksupply.com.");
      } catch (_) {
        fail("Couldn't reach our server. Check your connection and try again, or email hello@chipsharksupply.com.");
      }
    });
  };

  // ---- "Flag it urgent" links: preselect the urgent option on this page's form.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-cs-urgent]");
    if (!a) return;
    document.querySelectorAll('select[name="urgency"]').forEach((s) => {
      const opt = [...s.options].find((o) => /urgent/i.test(o.text));
      if (opt) s.value = opt.value || opt.text;
    });
  });

  // SMIL animations (moving dots) ignore the reduced-motion media query, so pause them by hand.
  if (reduce) document.querySelectorAll("svg").forEach((s) => s.pauseAnimations && s.pauseAnimations());

  window.CS = { watch, reduce };
})();
