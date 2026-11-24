(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  // storage can throw (private mode, blocked site data); the theme choice is only a convenience
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* ignore */
      }
    },
  };
  const svgEl = (parent, tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  };

  /* ── theme, menu, nav state ───────────────────────────── */
  $("#theme").addEventListener("click", () => {
    const r = document.documentElement;
    const cur =
      r.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    r.dataset.theme = cur === "dark" ? "light" : "dark";
    store.set("bx-theme", r.dataset.theme);
  });
  const menu = $("#menu"),
    links = $("#links");
  menu.addEventListener("click", () => {
    const o = links.classList.toggle("open");
    menu.setAttribute("aria-expanded", o);
  });
  $$("a", links).forEach((a) =>
    a.addEventListener("click", () => {
      links.classList.remove("open");
      menu.setAttribute("aria-expanded", false);
    }),
  );
  const onScroll = () => document.body.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const navObs = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (e.isIntersecting)
          $$("a", links).forEach((a) =>
            a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id),
          );
      }),
    { rootMargin: "-45% 0px -50% 0px" },
  );
  $$("main section[id]").forEach((s) => navObs.observe(s));

  /* ── reveal + one-shot triggers ───────────────────────── */
  const hooks = new Map();
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        const f = hooks.get(e.target);
        if (f) {
          hooks.delete(e.target);
          f();
        }
        io.unobserve(e.target);
      }),
    { threshold: 0.15 },
  );
  $$(".rv").forEach((el) => io.observe(el));
  const whenSeen = (el, fn) => {
    if (!el) return;
    hooks.set(el, fn);
    io.observe(el);
  };

  function countUp(el, to, ms = 1400) {
    const t0 = performance.now();
    const step = (t) => {
      const p = reduce ? 1 : Math.min(1, (t - t0) / ms),
        v = Math.round(to * (1 - Math.pow(1 - p, 3)));
      el.textContent = v.toLocaleString("en-US");
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── hero spotlight follows the pointer ───────────────── */
  const hero = $("#top"),
    spot = $("#spot");
  if (!reduce && matchMedia("(hover: hover)").matches)
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      spot.style.setProperty("--mx", e.clientX - r.left + "px");
      spot.style.setProperty("--my", e.clientY - r.top + "px");
    });

  /* ── geometry: a line between two boxes, clipped to their borders ── */
  function clip(ax, ay, bx, by, hw, hh) {
    const dx = bx - ax,
      dy = by - ay;
    const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return [ax + dx * s, ay + dy * s];
  }
  function edgePath(A, B, w, h) {
    const [x1, y1] = clip(A.x, A.y, B.x, B.y, w / 2 + 3, h / 2 + 3);
    const [x2, y2] = clip(B.x, B.y, A.x, A.y, w / 2 + 6, h / 2 + 6);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  function cyclePath(A, B, w, bend) {
    // two facing arcs between side-by-side boxes: one above, one below
    const dir = B.x > A.x ? 1 : -1,
      off = bend < 0 ? -8 : 8;
    const sx = A.x + (dir * w) / 2,
      ex = B.x - dir * (w / 2 + 5);
    return `M${sx} ${A.y + off} Q${(sx + ex) / 2} ${A.y + off + bend} ${ex} ${B.y + off}`;
  }
  function arrowDefs(svg, id) {
    const d = svgEl(svg, "defs", {});
    d.innerHTML = `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" fill="context-stroke"/></marker>`;
  }

  /* Real data: fixtures/sample-monorepo, from `buildrax scan` and model.json */
  const FILES = [
    "packages/api/src/server.ts",
    "packages/api/src/routes/orders.ts",
    "packages/api/src/services/billing.ts",
    "packages/api/src/services/orders.ts",
    "packages/shared/src/index.ts",
    "packages/shared/src/types.ts",
    "services/worker/worker/__init__.py",
    "services/worker/worker/helpers.py",
    "services/worker/worker/jobs.py",
    "services/worker/worker/main.py",
  ];

  /* ── hero motion graphic: the scan, drawn live ─────────── */
  (() => {
    const svg = $("#scanSvg"),
      list = $("#scanFiles"),
      status = $("#scanStatus"),
      bar = $("#scanBar"),
      clock = $("#scanClock");
    arrowDefs(svg, "sa");
    const W = 106,
      H = 34;
    const N = {
      miss: { x: 62, y: 40, t: "missing.js", k: "UNRESOLVED", c: "un", f: 0 },
      server: { x: 200, y: 40, t: "server.ts", k: "API", f: 0 },
      express: { x: 338, y: 40, t: "express", k: "EXTERNAL", c: "ext", f: 0 },
      routes: { x: 120, y: 128, t: "routes/orders", k: "API", f: 1 },
      shared: { x: 320, y: 128, t: "@sample/shared", k: "WORKSPACE", f: 4 },
      sord: { x: 80, y: 222, t: "orders.ts", k: "SERVICES", f: 3 },
      bill: { x: 250, y: 222, t: "billing.ts", k: "SERVICES", f: 2 },
      stripe: { x: 338, y: 302, t: "stripe", k: "EXTERNAL", c: "ext", f: 2 },
      jobs: { x: 62, y: 302, t: "jobs.py", k: "WORKER", f: 8 },
      redis: { x: 186, y: 302, t: "redis", k: "EXTERNAL", c: "ext", f: 8 },
    };
    const E = [
      ["server", "routes"],
      ["server", "express"],
      ["server", "shared"],
      ["server", "miss", "un"],
      ["routes", "bill"],
      ["routes", "sord"],
      ["bill", "sord", "cy"],
      ["sord", "bill", "cy"],
      ["bill", "stripe"],
      ["jobs", "redis"],
    ];
    const eg = svgEl(svg, "g", {}),
      ng = svgEl(svg, "g", {});
    const edges = E.map(([a, b, c]) => {
      const d =
        c === "cy" ? cyclePath(N[a], N[b], W, a === "bill" ? -40 : 40) : edgePath(N[a], N[b], W, H);
      return { p: svgEl(eg, "path", { d, class: "e", "marker-end": "url(#sa)" }), c };
    });
    for (const k in N) {
      const n = N[k],
        g = svgEl(ng, "g", { class: "n " + (n.c || "") });
      svgEl(g, "rect", { x: n.x - W / 2, y: n.y - H / 2, width: W, height: H, rx: 8 });
      svgEl(g, "text", { x: n.x, y: n.y - 1, "text-anchor": "middle" }).textContent = n.t;
      svgEl(g, "text", { x: n.x, y: n.y + 11, "text-anchor": "middle", class: "k" }).textContent =
        n.k;
      n.g = g;
    }
    list.innerHTML = FILES.map(
      (f) => `<li title="${esc(f)}">${esc(f.split("/").slice(-2).join("/"))}</li>`,
    ).join("");
    const lis = $$("li", list);

    function reset() {
      lis.forEach((l) => {
        l.className = "";
      });
      for (const k in N) N[k].g.classList.remove("on", "cy");
      edges.forEach((e) => {
        const L = e.p.getTotalLength();
        e.p.classList.remove("cy", "pulse");
        e.p.style.transition = "none";
        e.p.style.strokeDasharray = L;
        e.p.style.strokeDashoffset = L;
      });
      bar.style.width = "0";
      clock.textContent = "0.0 s";
      status.textContent = "reading manifests…";
    }
    let token = 0;
    async function run() {
      const my = ++token;
      reset();
      await wait(500);
      for (let i = 0; i < FILES.length; i++) {
        if (my !== token) return;
        lis.forEach((l) => l.classList.remove("cur"));
        lis[i].classList.add("cur", "on");
        status.innerHTML = "parsing <b>" + esc(FILES[i].split("/").pop()) + "</b>";
        bar.style.width = ((i + 1) / FILES.length) * 100 + "%";
        clock.textContent = ((i + 1) / FILES.length).toFixed(1) + " s";
        for (const k in N) if (N[k].f === i) N[k].g.classList.add("on");
        await wait(260);
      }
      lis.forEach((l) => l.classList.remove("cur"));
      status.textContent = "resolving imports…";
      for (const e of edges) {
        if (my !== token) return;
        e.p.style.transition = "";
        e.p.style.strokeDashoffset = 0;
        if (e.c === "un")
          setTimeout(
            () => {
              e.p.style.strokeDasharray = "2 4";
            },
            reduce ? 0 : 900,
          );
        await wait(130);
      }
      await wait(700);
      edges
        .filter((e) => e.c === "cy")
        .forEach((e) => {
          e.p.style.strokeDasharray = "none";
          e.p.classList.add("cy", "pulse");
        });
      N.bill.g.classList.add("cy");
      N.sord.g.classList.add("cy");
      status.innerHTML =
        '<b>24 nodes · 16 edges</b> · <span class="bad">1 circular dependency</span>';
      await wait(5200);
      if (my === token && !reduce) run();
    }
    let running = false;
    new IntersectionObserver(
      (es) => {
        const v = es[0].isIntersecting;
        if (v && !running) {
          running = true;
          run();
        }
        if (!v) {
          token++;
          running = false;
        }
      },
      { threshold: 0.2 },
    ).observe($(".scan"));
  })();

  /* ── stats count-up ───────────────────────────────────── */
  whenSeen($("#stats"), () =>
    $$("#stats [data-count]").forEach((el) => countUp(el, +el.dataset.count)),
  );

  /* ── marquee: duplicate the track for a seamless loop ── */
  (() => {
    const t = $("#mq");
    t.innerHTML += t.innerHTML.replace(/<span>/g, '<span aria-hidden="true">');
  })();

  /* ── viewer tour (the real GIFs) ───────────────────────── */
  (() => {
    const T = [
      {
        k: "Explore",
        d: "The whole map",
        gif: "explore.gif",
        file: "view.html · Graph",
        cmd: "buildrax view . --open",
        cap: "Open packages into segment boxes. Click one to light up what it uses (blue) and what uses it (orange), then focus on a single package.",
        alt: "The Graph view of this repository: packages opened into segment boxes, a package clicked to highlight what it uses and what uses it, then the Nodes view and Focus",
      },
      {
        k: "Trace",
        d: "Impact, line by line",
        gif: "trace-code.gif",
        file: "view.html · Nodes · Code view",
        cmd: "buildrax trace src/billing.ts --direction up",
        cap: "Step through how a file connects. Then turn on Code view and click a file or a database to read the exact lines. Config secrets are masked.",
        alt: "The Inspector trace stepped through for server.ts, then Code view showing the lines behind a file and a database",
      },
      {
        k: "Flows",
        d: "Endpoint → database",
        gif: "flows.gif",
        file: "view.html · Flows",
        cmd: "buildrax routes --reaching database:postgres",
        cap: "Every endpoint across frameworks. Follow GET /api/orders down to PostgreSQL and open each step’s code in a floating window.",
        alt: "The Flows view: GET /api/orders drawn in lanes down to PostgreSQL, with steps opening their code",
      },
      {
        k: "Cost",
        d: "Price per traffic tier",
        gif: "cost.gif",
        file: "view.html · Cost",
        cmd: "buildrax cost --mode product",
        cap: "Monthly estimates at five traffic tiers. Double an assumption and every tier recomputes. Prices come from dated list prices, and anything without a price feed says “price needed”.",
        alt: "The Cost view: five traffic tiers with monthly estimates, recomputing when an assumption is doubled",
      },
    ];
    const DUR = 22000;
    const tabs = $("#tourTabs"),
      img = $("#tourImg"),
      load = $("#tourLoad");
    const cache = {};
    const fetchGif = (src) =>
      cache[src] ||
      (cache[src] = new Promise((res) => {
        const i = new Image();
        i.onload = i.onerror = () => res(src);
        i.src = "assets/" + src;
      }));
    T.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "tt";
      b.setAttribute("role", "tab");
      b.id = "tt" + i;
      b.innerHTML = `<span class="num">0${i + 1}</span><b>${esc(t.k)}</b><span class="d">${esc(t.d)}</span>`;
      b.addEventListener("click", () => show(i));
      tabs.appendChild(b);
    });
    let cur = 0,
      t0 = performance.now(),
      visible = false,
      pausedAt = 0;
    async function show(i) {
      cur = i;
      t0 = performance.now();
      pausedAt = 0;
      const t = T[i];
      $$(".tt", tabs).forEach((b, j) => {
        b.setAttribute("aria-selected", j === i);
        b.style.setProperty("--p", "0%");
      });
      $("#tourFile").textContent = t.file;
      $("#tourCap").textContent = t.cap;
      $("#tourCmd").textContent = t.cmd;
      if (!img.getAttribute("src").endsWith(t.gif)) {
        load.classList.add("on");
        await fetchGif(t.gif);
        if (cur !== i) return;
        img.classList.add("hide");
        await wait(220);
        img.src = "assets/" + t.gif;
        img.classList.remove("hide");
        load.classList.remove("on");
      }
      img.alt = t.alt;
      t0 = performance.now();
      fetchGif(T[(i + 1) % T.length].gif); // warm the next clip
    }
    function tick(now) {
      const running = visible && !document.hidden && !reduce;
      if (running) {
        if (pausedAt) {
          t0 += now - pausedAt;
          pausedAt = 0;
        }
        const p = Math.min(1, (now - t0) / DUR);
        $("#tt" + cur).style.setProperty("--p", p * 100 + "%");
        if (p >= 1) show((cur + 1) % T.length);
      } else if (!pausedAt) pausedAt = now;
      requestAnimationFrame(tick);
    }
    show(0);
    new IntersectionObserver(
      (es) => {
        visible = es[0].isIntersecting;
      },
      { threshold: 0.35 },
    ).observe($(".stage"));
    requestAnimationFrame(tick);
  })();

  /* ── problems ─────────────────────────────────────────── */
  (() => {
    const P = [
      [
        "Nobody knows how this fits together.",
        "A map built from the code itself, not from stale diagrams. Every link points at the import that creates it.",
        "Graph · Nodes · digest",
      ],
      [
        "If I change this file, what breaks?",
        "Transitive impact, hop by hop, with the file:line behind each step.",
        "trace --direction up",
      ],
      [
        "What does this endpoint actually touch?",
        "Every route across eight frameworks, followed to the databases and services it can reach.",
        "routes · flow · Flows view",
      ],
      [
        "The AI wrote files and dependencies I never designed.",
        "What was added, removed or rewired since the last scan or any commit.",
        "diff --since main · scan --watch",
      ],
      [
        "My agent burns tokens reading the whole repo.",
        "A digest of about 420 tokens and question packs of about 4k, all with file:line anchors.",
        "digest · context",
      ],
      [
        "Circular imports make every change risky.",
        "Found on every scan, highlighted in red, and listed in the summary.",
        "scan · Graph view",
      ],
      [
        "Which databases, queues and paid APIs do we run?",
        "Detected from compose, Terraform, Kubernetes, platform files and SDK imports, each with evidence.",
        "Infrastructure",
      ],
      [
        "The hosting bill is a mystery. Will it scale?",
        "Monthly cost from 100 to 1M users, using dated list prices, with the bottleneck at each tier.",
        "cost · Cost view",
      ],
      [
        "Are our runtimes outdated or our dependencies vulnerable?",
        "Opt-in OSV.dev advisories for pinned versions, plus end-of-life dates for your runtimes.",
        "research --online",
      ],
    ];
    $("#rows").innerHTML = P.map(
      ([q, a, t], i) =>
        `<li class="row rv${i % 3 ? " d" + (i % 3) : ""}"><span class="num">${String(i + 1).padStart(2, "0")}</span><q>${esc(q)}</q><div class="a">${esc(a)}<br><span class="tag">${esc(t)}</span></div></li>`,
    ).join("");
    $$("#rows .rv").forEach((el) => io.observe(el));
  })();

  /* ── interactive explorer ──────────────────────────────── */
  (() => {
    const svg = $("#xg");
    arrowDefs(svg, "xa");
    const W = 150,
      H = 48;
    const N = {
      miss: { x: 95, y: 52, t: "missing.js", k: "UNRESOLVED", p: "./missing.js" },
      server: { x: 320, y: 52, t: "server.ts", k: "API", p: "packages/api/src/server.ts" },
      express: { x: 545, y: 52, t: "express", k: "EXTERNAL", p: "express" },
      routes: {
        x: 205,
        y: 172,
        t: "routes/orders.ts",
        k: "API",
        p: "packages/api/src/routes/orders.ts",
      },
      shared: { x: 545, y: 172, t: "@sample/shared", k: "WORKSPACE", p: "packages/shared" },
      sord: {
        x: 120,
        y: 300,
        t: "orders.ts",
        k: "SERVICES",
        p: "packages/api/src/services/orders.ts",
      },
      bill: {
        x: 420,
        y: 300,
        t: "billing.ts",
        k: "SERVICES",
        p: "packages/api/src/services/billing.ts",
      },
      stripe: { x: 545, y: 395, t: "stripe", k: "EXTERNAL", p: "stripe" },
    };
    // [from, to, line, kind]: every line number comes from model.json evidence
    const E = [
      ["server", "routes", 4],
      ["server", "express", 1],
      ["server", "shared", 3],
      ["server", "miss", 5, "un"],
      ["routes", "bill", 2],
      ["routes", "sord", 1],
      ["bill", "sord", 1, "cy"],
      ["sord", "bill", 1, "cy"],
      ["bill", "stripe", 2],
    ];
    const eg = svgEl(svg, "g", {}),
      ng = svgEl(svg, "g", {});
    const eEls = E.map(([a, b, , c]) => {
      const d =
        c === "cy" ? cyclePath(N[a], N[b], W, a === "bill" ? -54 : 54) : edgePath(N[a], N[b], W, H);
      const p = svgEl(eg, "path", {
        d,
        class: "e" + (c === "cy" ? " cy" : ""),
        "marker-end": "url(#xa)",
      });
      if (c === "un") p.setAttribute("stroke-dasharray", "3 5");
      return p;
    });
    const nEls = {};
    for (const k in N) {
      const n = N[k];
      const g = svgEl(ng, "g", {
        class: "n",
        tabindex: 0,
        role: "button",
        "aria-label": "Select " + n.p,
      });
      svgEl(g, "rect", { x: n.x - W / 2, y: n.y - H / 2, width: W, height: H, rx: 10 });
      svgEl(g, "text", { x: n.x, y: n.y - 2, "text-anchor": "middle" }).textContent = n.t;
      svgEl(g, "text", { x: n.x, y: n.y + 14, "text-anchor": "middle", class: "k" }).textContent =
        n.k;
      g.addEventListener("click", () => pick(k));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick(k);
        }
      });
      nEls[k] = g;
    }
    let dir = "up",
      sel = null;
    function walk(start) {
      const seen = { [start]: 0 },
        out = [],
        q = [start];
      while (q.length) {
        const c = q.shift();
        E.forEach(([a, b, l, kind]) => {
          const from = dir === "up" ? b : a,
            to = dir === "up" ? a : b;
          // evidence lives in the importing file: `to` when walking up, `c` when walking down
          if (from === c && !(to in seen)) {
            seen[to] = seen[c] + 1;
            out.push({ k: to, hop: seen[to], l, kind, src: dir === "up" ? N[to].p : N[c].p });
            q.push(to);
          }
        });
      }
      return { seen, out };
    }
    function pick(k) {
      sel = k;
      render();
    }
    function render() {
      const { seen, out } = walk(sel);
      const cls = dir === "up" ? "up" : "dn";
      for (const k in nEls)
        nEls[k].setAttribute("class", "n " + (k === sel ? "sel" : k in seen ? cls : "dim"));
      E.forEach(([a, b, , c], i) =>
        eEls[i].setAttribute(
          "class",
          "e" + (c === "cy" ? " cy" : "") + (a in seen && b in seen ? " " + cls : " dim"),
        ),
      );
      const n = N[sel];
      $("#iName").textContent = n.p;
      $("#iNote").textContent = out.length
        ? dir === "up"
          ? `${out.length} node(s) could break if this changes:`
          : `${out.length} node(s) it relies on:`
        : dir === "up"
          ? "Nothing in the repo depends on this."
          : "It depends on nothing further.";
      $("#iList").innerHTML = out
        .map((o) => {
          const file = o.src.split("/").slice(-2).join("/");
          return `<li class="${o.kind === "cy" ? "c" : dir === "up" ? "" : "d"}" style="animation-delay:${o.hop * 90}ms;margin-left:${(o.hop - 1) * 12}px"><span>${esc(N[o.k].p)}</span>${o.kind === "cy" ? '<span class="cy">circular</span>' : `<span class="ln">${esc(file)}:${o.l}</span>`}</li>`;
        })
        .join("");
      $("#iCmd").textContent = `buildrax trace ${n.p} --direction ${dir === "up" ? "up" : "down"}`;
    }
    const setDir = (d) => {
      dir = d;
      $("#dUp").setAttribute("aria-pressed", d === "up");
      $("#dDn").setAttribute("aria-pressed", d === "down");
      if (sel) render();
    };
    $("#dUp").addEventListener("click", () => setDir("up"));
    $("#dDn").addEventListener("click", () => setDir("down"));
    whenSeen($(".explorer"), () =>
      setTimeout(
        () => {
          if (!sel) pick("bill");
        },
        reduce ? 0 : 600,
      ),
    );
  })();

  /* ── terminal replay (real CLI output) ─────────────────── */
  (() => {
    const pre = $("#tm");
    const S = [
      ["$", "buildrax scan ."],
      [
        ">",
        `<span class="p">Scanned sample-monorepo</span>  (python, typescript)
  10 files · 6 modules · 4 external · 1 unresolved
  24 nodes · 16 edges
  <span class="r">1 circular dependency:</span>
    packages/api/src/services/billing.ts <-> .../services/orders.ts
  parsed 10 file(s), reused 0 unchanged, in 1.0 s
`,
      ],
      ["$", "buildrax digest ."],
      [
        ">",
        `BUILDRAX DIGEST repo=sample-monorepo schema=buildrax-ir/v2
languages: python, typescript | files=10 nodes=24 edges=16
<span class="m">static analysis only: not observed at runtime</span>

MODULES
M2 packages/api [npm @sample/api] files=4 <span class="r">CYCLE</span> -> X1 X4 M3 M5 U1
M3 packages/shared [npm @sample/shared] files=2
M4 services/worker [python sample-worker] files=4 -> M1 X2 X3

EXTERNAL  X1 express · X2 redis · X3 requests · X4 stripe

UNRESOLVED IMPORTS <span class="m">(do not assume they exist)</span>
packages/api/src/server.ts:5 ./missing.js
`,
      ],
      ["$", "buildrax trace packages/api/src/services/billing.ts"],
      [
        ">",
        `Everything that depends on billing.ts (what could break if it changes)
3 node(s), 3 file(s)
  <span class="o">packages/api/src/routes/orders.ts:2</span>
  <span class="o">packages/api/src/services/orders.ts:1</span>
    <span class="o">packages/api/src/server.ts:4</span>
`,
      ],
    ];
    let run = 0;
    async function go() {
      const id = ++run;
      pre.innerHTML = "";
      for (const [k, t] of S) {
        if (id !== run) return;
        const line = document.createElement("div");
        if (k === "$") {
          line.innerHTML = '<span class="g">❯</span> <span></span><span class="caret"></span>';
          pre.appendChild(line);
          const sp = line.children[1];
          for (const ch of t) {
            if (id !== run) return;
            sp.textContent += ch;
            await wait(26);
          }
          await wait(280);
          line.querySelector(".caret").remove();
        } else {
          line.innerHTML = t;
          line.style.animation = "rise .5s var(--ease) both";
          pre.appendChild(line);
          await wait(1100);
        }
        pre.scrollTop = pre.scrollHeight;
      }
      const end = document.createElement("div");
      end.innerHTML = '<span class="g">❯</span> <span class="caret"></span>';
      pre.appendChild(end);
    }
    $("#replay").addEventListener("click", go);
    whenSeen(pre, go);
  })();

  /* ── token bars ───────────────────────────────────────── */
  whenSeen($("#tokens"), () =>
    $$("#tokens .tk").forEach((r, i) =>
      setTimeout(
        () => {
          const bar = $("i", r);
          bar.style.width = Math.max(0.9, +bar.dataset.w) + "%";
          const b = $("b", r);
          countUp(b, +b.dataset.n, 1800);
        },
        reduce ? 0 : i * 260,
      ),
    ),
  );

  /* ── personas ─────────────────────────────────────────── */
  (() => {
    const P = [
      [
        "Indie hacker",
        [
          [
            "returning to a side project after two months",
            "a one-screen overview of its packages and hubs",
            "I can start a change without rereading everything",
            "buildrax view --open",
          ],
          [
            "planning a launch",
            "to know what the app would cost at 10k and 100k users and what breaks first",
            "I can price my plan and avoid surprises",
            "buildrax cost --mode product",
          ],
        ],
      ],
      [
        "Developer",
        [
          [
            "about to refactor billing.ts",
            "every file that depends on it, hop by hop, with the import lines",
            "I know what to retest",
            "buildrax trace src/billing.ts --direction up",
          ],
          [
            "reviewing a pull request",
            "the architecture changes in plain words",
            "I can spot a new dependency or a cycle without reading the whole diff",
            "buildrax diff --since origin/main --markdown",
          ],
        ],
      ],
      [
        "Vibe-coder",
        [
          [
            "who let an AI build the backend",
            "to see every endpoint and which database each one touches",
            "I can check it did what I asked",
            "buildrax routes --reaching database:postgres",
          ],
          [
            "reading generated code",
            "to click an arrow and read the lines that create it",
            "I understand it without opening ten files",
            "Code view: press K, then click the arrow",
          ],
        ],
      ],
      [
        "Context engineer",
        [
          [
            "feeding an agent",
            "a bounded, evidence-linked context pack for one question",
            "my agent answers from facts and spends thousands of tokens instead of hundreds of thousands",
            'buildrax context "how does checkout talk to Stripe" --budget 3000',
          ],
          [
            "caching prompts",
            "the same repository to always produce the same IDs and digest",
            "prompts and caches stay stable across runs",
            "buildrax digest .",
          ],
        ],
      ],
      [
        "Founder",
        [
          [
            "talking to an investor or a new hire",
            "one place for the architecture, infrastructure and monthly cost",
            "I can answer with evidence instead of guesses",
            "buildrax view . --open",
          ],
          [
            "worried about risk",
            "to know which runtimes are end-of-life and which pinned versions have advisories",
            "I can fix risk early",
            "buildrax research --online",
          ],
        ],
      ],
      [
        "Team",
        [
          [
            "leading a growing codebase",
            "the map rebuilt on every push, with an architecture summary on each PR",
            "erosion is caught in review",
            "buildrax diff --since origin/main --markdown",
          ],
          [
            "protecting main",
            "CI to fail when a PR introduces a circular dependency",
            "cycles never merge unnoticed",
            "buildrax diff --since origin/main --fail-on-new-cycles",
          ],
        ],
      ],
    ];
    const tabs = $("#ptabs"),
      body = $("#pBody");
    P.forEach(([name], i) => {
      const b = document.createElement("button");
      b.className = "ptab";
      b.setAttribute("role", "tab");
      b.textContent = name;
      b.addEventListener("click", () => sel(i));
      tabs.appendChild(b);
    });
    function sel(i) {
      $$(".ptab", tabs).forEach((b, j) => b.setAttribute("aria-selected", j === i));
      const [name, s] = P[i];
      body.innerHTML = s
        .map(
          ([who, want, so, cmd], j) =>
            `<article class="story"><p>As a <b>${esc(name.toLowerCase())}</b> ${esc(who)}, I want <b>${esc(want)}</b>, so that ${esc(so)}.</p><span class="pill-cmd"><code id="ps${j}">${esc(cmd)}</code><button class="copy" data-copy="#ps${j}">Copy</button></span></article>`,
        )
        .join("");
    }
    sel(0);
  })();

  /* ── CI gates ─────────────────────────────────────────── */
  whenSeen($("#gates"), async () => {
    const g = $$("#gates .gate");
    for (let i = 0; i < g.length; i++) {
      g[i].classList.add("on");
      const b = $(".badge", g[i]);
      b.textContent = "RUNNING";
      await wait(900);
      if (i < 2) {
        b.textContent = "PASS";
        b.classList.add("pass");
      } else {
        $("#gWarn").classList.add("on");
        await wait(500);
        b.textContent = "FAIL";
        b.classList.add("fail");
      }
    }
  });

  /* ── copy buttons ─────────────────────────────────────── */
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    const src = $(b.dataset.copy);
    if (!src) return;
    const done = () => {
      b.textContent = "Copied";
      b.classList.add("ok");
      setTimeout(() => {
        b.textContent = "Copy";
        b.classList.remove("ok");
      }, 1400);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(src.textContent).then(done, () => {});
    else {
      const r = document.createRange();
      r.selectNodeContents(src);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  });

  /* ── footer wordmark fills as you reach the end ─────────── */
  (() => {
    const wm = $("#wordmark");
    if (reduce) {
      wm.style.setProperty("--fill", "100%");
      return;
    }
    const upd = () => {
      const r = wm.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (innerHeight - r.top) / (r.height + innerHeight * 0.35)));
      wm.style.setProperty("--fill", (p * 100).toFixed(1) + "%");
    };
    addEventListener("scroll", upd, { passive: true });
    upd();
  })();
})();
