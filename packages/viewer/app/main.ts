import "./theme.css";
import "./scene.css";
import "./panels.css";
import "./toolbar.css";
import "./blueprint.css";
import "./cost.css";
import {
  GraphIndex,
  buildView,
  fileCycles,
  hubs,
  searchNodes,
  type GraphView,
} from "@buildrax/graph";
import { validateModel, validateNotes, type Model, type NodeKind } from "@buildrax/ir";
import { h, put, s } from "./dom.js";
import { createCodeSource } from "./code-source.js";
import { renderCodePanel } from "./code-ui.js";
import { renderInspector } from "./inspector.js";
import { edgeBadges, nodeBadges } from "./notes-logic.js";
import { LocalStorageStore, ServerStore, type NotesStore } from "./notes-store.js";
import { relocateNotes, renderNotesPanel, renderNotesSection } from "./notes-ui.js";
import { layoutView } from "./layout.js";
import { computeLineage } from "./lineage.js";
import { parseResearch, renderResearchSection } from "./research-ui.js";
import { parseCost, renderCostSection, renderCostView } from "./cost-ui.js";
import { renderFlowsView, type FlowsUi } from "./flows-ui.js";
import { FloatingCode, SHEET_BELOW } from "./flows-code.js";
import { fileView, selectionView, traceStepView } from "./canvas-code.js";
import { codeSwitch } from "./code-switch.js";
import type { TraceStep } from "./trace.js";
import { startLiveUpdates, type LiveConfig } from "./live.js";
import type { Assumptions } from "@buildrax/cost";
import { radiusFor } from "./geometry.js";
import { buildGroups, type Groups } from "./groups.js";
import {
  COLOR_MODES,
  legendFor,
  packageHues,
  packageOf,
  swatchFor,
  type ColorMode,
} from "./palette.js";
import { Blueprint } from "./blueprint.js";
import { blueprintLayout } from "./blueprint-layout.js";
import { focusView, nodeViewLayout } from "./node-view.js";
import { buildTrace, limitLineage, stepNumbers, type TraceDirection } from "./trace.js";
import { renderTraceSection } from "./trace-ui.js";
import { iconButton, Panels } from "./panels.js";
import { Scene, type NodeStyle, type Selection } from "./scene.js";
import { decodeState, encodeState, type ViewState } from "./state-url.js";

const root = document.getElementById("app")!;

function readEmbedded(): unknown {
  const text = document.getElementById("buildrax-data")?.textContent?.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function showDropZone(errors: string[] = []): void {
  const input = h("input", { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const result = validateModel(JSON.parse(await file.text()));
      if (result.ok && result.model) start(result.model);
      else showDropZone(result.errors.slice(0, 10));
    } catch (err) {
      showDropZone([String(err)]);
    }
  });
  root.replaceChildren(
    h(
      "div",
      { class: "drop" },
      h("h1", null, "BuildRAX"),
      h(
        "p",
        null,
        "No architecture model embedded. Open a model.json produced by `buildrax scan`.",
      ),
      input,
      errors.length ? h("p", { class: "errors" }, errors.join("\n")) : null,
    ),
  );
}

function readThemePref(): ViewState["theme"] | undefined {
  try {
    const v = window.localStorage.getItem("buildrax:theme");
    return v === "light" || v === "dark" || v === "auto" ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeThemePref(theme: ViewState["theme"]): void {
  try {
    window.localStorage.setItem("buildrax:theme", theme);
  } catch {
    /* storage blocked: the choice still lasts for this page via the URL hash */
  }
}

function readJson(id: string): unknown {
  const text = document.getElementById(id)?.textContent?.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function createStore(model: Model, onError: (m: string) => void): NotesStore {
  const config = readJson("buildrax-config") as { server?: boolean; token?: string } | undefined;
  if (config?.server && typeof config.token === "string") {
    const store = new ServerStore(config.token, (url, init) => fetch(url, init), onError);
    void store.init();
    return store;
  }
  const embedded = validateNotes(readJson("buildrax-notes"));
  return new LocalStorageStore(
    `buildrax:notes:${model.meta.repo}`,
    embedded.ok && embedded.file ? embedded.file.notes : [],
    browserStorage(),
  );
}

function start(model: Model): void {
  const index = new GraphIndex(model);
  const state: ViewState = decodeState(location.hash);
  if (!location.hash) {
    const saved = readThemePref();
    if (saved) state.theme = saved;
  }
  // The operating system's "reduce motion" setting wins over a shared link; the toggle can re-enable it.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) state.motion = false;
  let view: GraphView = { nodes: [], edges: [] };
  let seq = 0;
  let focusKey: string | undefined;
  // Step-by-step trace of the selected node (reset whenever the selection changes).
  const trace = { for: "", direction: "both" as TraceDirection, step: 0, playing: false, timer: 0 };
  const stopTrace = (): void => {
    window.clearInterval(trace.timer);
    trace.playing = false;
  };

  const cycles = fileCycles(index);
  const cyclesFor = (id: string): string[][] => {
    const scope = new Set([id, ...index.descendants(id)]);
    return cycles.filter((c) => c.some((f) => scope.has(f)));
  };

  // ---- DOM skeleton ----
  const svg = s("svg", {
    class: "stage stage-graph",
    role: "application",
    "aria-label": "Architecture graph",
  });
  const bpSvg = s("svg", {
    class: "stage stage-nodes",
    role: "application",
    "aria-label": "Architecture nodes",
  });
  // Both views share the same handlers, so selection, focus and collapse behave identically.
  const viewEvents = {
    select: (sel: Selection | undefined): void => {
      state.selected = sel;
      forceCode = true; // a click on the canvas always (re)opens the code window
      paint();
      writeHash();
    },
    // Double-click: in focus it moves the focus; otherwise it expands packages and folders.
    activate: (id: string, expandable: boolean): void => {
      if (state.focus) void setFocus(id);
      else if (expandable) void expand(id);
    },
    collapse: (id: string): void => void collapse(id),
  };
  const scene = new Scene(svg, viewEvents);
  const blueprint = new Blueprint(bpSvg, viewEvents);
  /** The renderer of the view on screen, for camera actions shared by both views. */
  const active = (): Scene | Blueprint => (state.view === "nodes" ? blueprint : scene);

  const searchInput = h("input", {
    type: "search",
    placeholder: "Search ( / )",
    "aria-label": "Search architecture",
  });
  const results = h("div", { class: "results" });
  const select = (label: string, opts: [string, string][]): HTMLSelectElement =>
    h("select", { "aria-label": label }, ...opts.map(([v, t]) => h("option", { value: v }, t)));
  const depthSel = select("Lineage depth", [
    ["1", "1 hop"],
    ["2", "2 hops"],
    ["3", "3 hops"],
    ["0", "all"],
  ]);
  const colorSel = select(
    "Color by",
    COLOR_MODES.map((c) => [c, c === "heat" ? "connectivity (heat)" : c]),
  );
  const segLayered = h("button", { type: "button", role: "radio" }, "Layered");
  const segForce = h("button", { type: "button", role: "radio" }, "Live");
  const clusterBox = h("input", { type: "checkbox" });
  const motionBox = h("input", { type: "checkbox" });
  const extBox = h("input", { type: "checkbox" });
  const unrBox = h("input", { type: "checkbox" });
  const themeBtn = h("button", { type: "button" }, "Theme");
  const segGraph = h(
    "button",
    { type: "button", role: "radio", title: "Orbs, live physics and segment boxes (V)" },
    "Graph",
  );
  const segNodes = h(
    "button",
    { type: "button", role: "radio", title: "Structured cards with routed arrows (V)" },
    "Nodes",
  );
  const segFlows = h(
    "button",
    { type: "button", role: "radio", title: "Endpoints and what they reach (E)" },
    "Flows",
  );
  const segCost = h(
    "button",
    { type: "button", role: "radio", title: "Monthly cost per traffic tier (C)" },
    "Cost",
  );
  const fitBtn = h("button", { type: "button" }, "Fit");
  const shakeBtn = h(
    "button",
    { type: "button", class: "live-only", title: "Re-run the physics" },
    "Shake",
  );
  const unpinBtn = h(
    "button",
    { type: "button", class: "live-only", title: "Release dragged nodes" },
    "Unpin",
  );
  const collapseBtn = h("button", { type: "button" }, "Collapse all packages");
  const leftActions = h("div", { class: "panel-actions" });
  const leftHead = h(
    "div",
    { class: "panel-head" },
    h("span", { class: "panel-title" }, "Overview"),
    leftActions,
  );
  const leftBody = h("div", { class: "panel-body" });
  const left = h("aside", { class: "left", "aria-label": "Overview" }, leftHead, leftBody);
  const notesStatus = h("p", { class: "warn", role: "status" });
  const notesBox = h("div", { class: "notes-box" });
  const research = parseResearch(readJson("buildrax-research"));
  const costData = parseCost(readJson("buildrax-cost"));
  const costUi: { tier: number; edits: Partial<Assumptions> } = { tier: 0, edits: {} };
  const costBox = h("div", { class: "cost-view", hidden: "", "aria-label": "Cost estimate" });
  const flowsBox = h("div", { class: "cost-view flows-view", hidden: "", "aria-label": "Flows" });
  const readFlag = (key: string): boolean => {
    try {
      return window.localStorage.getItem(key) === "on";
    } catch {
      return false;
    }
  };
  // Code view in Flows is opt-in and remembered in this browser.
  const flowsUi: FlowsUi = {
    route: state.route,
    filter: "",
    // One Code view switch for every view (the old Flows-only setting is migrated).
    code: readFlag("buildrax:code-view") || readFlag("buildrax:flows-code"),
  };
  const store = createStore(model, (msg) => void (notesStatus.textContent = msg));
  const inspectorBox = h("div", { class: "tab-body", "aria-live": "polite" });
  const codeBox = h("div", { class: "tab-body code-box" });
  const tabInspector = h("button", { type: "button", role: "tab" }, "Inspector");
  const tabCode = h("button", { type: "button", role: "tab" }, "Code");
  const rightActions = h("div", { class: "panel-actions" });
  // Pop the Code tab out into the floating window (shown while the Code tab is open).
  const popOutBtn = h(
    "button",
    {
      type: "button",
      class: "pop-out",
      title: "Pop out: show this code in a floating window over the canvas (turns Code view on)",
      "aria-label": "Pop out the code into a floating window",
    },
    "⧉",
  );
  popOutBtn.addEventListener("click", () => popOutCode());
  const rightHead = h(
    "div",
    { class: "tabs" },
    h("div", { class: "tab-list", role: "tablist" }, tabInspector, tabCode, popOutBtn),
    rightActions,
  );
  const right = h(
    "aside",
    { class: "right", "aria-label": "Inspector" },
    rightHead,
    inspectorBox,
    codeBox,
  );
  const source = createCodeSource(
    readJson("buildrax-config") as { server?: boolean; token?: string } | undefined,
    readJson("buildrax-sources"),
    (url, init) => fetch(url, init),
    readJson("buildrax-excerpts"),
  );
  let codeSeq = 0;
  // Floating code window for the Flows view (one per page, created only if source can be read).
  const flowsCode = source.mode === "none" ? undefined : new FloatingCode(source);
  if (flowsCode) document.body.append(flowsCode.el);
  const CODE_UNAVAILABLE =
    "Code view is unavailable: this viewer was built with buildrax view --no-source. Rebuild it without that flag, or use buildrax serve.";
  // What the code window currently shows on the canvas, to avoid reloading on every repaint.
  let codeKey = "";
  let closedCodeKey = "";
  let forceCode = false;
  const syncCanvasCode = (sel: Selection | undefined, steps: TraceStep[]): void => {
    const force = forceCode;
    forceCode = false;
    if (!flowsCode || !flowsUi.code || state.flows || state.cost) return;
    const key = sel ? `${sel.type}:${sel.id}|${trace.step}|${trace.direction}` : "";
    if (!force && (key === codeKey || key === closedCodeKey)) return;
    codeKey = key;
    closedCodeKey = "";
    if (!sel) return void flowsCode.close();
    // While stepping through the trace, show the lines behind the current step.
    const current = trace.step > 0 ? steps.filter((st) => st.n === trace.step) : [];
    const v = current.length
      ? traceStepView(index, {
          n: trace.step,
          direction: current[0]!.direction,
          links: current.flatMap((st) => st.links),
        })
      : selectionView(index, view, sel);
    if (!v) return;
    void flowsCode.showView(v).then(() => {
      // Never hide what was clicked: if the window covers the node, slide the camera.
      if (force && sel.type === "node") keepVisible(sel.id);
    });
  };
  const keepVisible = (id: string): void => {
    if (!flowsCode?.open || window.innerWidth < SHEET_BELOW) return;
    const pt = active().screenPoint(id);
    const win = flowsCode.el.getBoundingClientRect();
    const area = canvas.getBoundingClientRect();
    if (!pt || !area.width) return;
    const pad = 40;
    const covered =
      pt.x > win.left - pad &&
      pt.x < win.right + pad &&
      pt.y > win.top - pad &&
      pt.y < win.bottom + pad;
    if (!covered) return;
    // Centre the node in the larger free strip beside the window.
    const leftFree = win.left - area.left;
    const rightFree = area.right - win.right;
    const fx =
      leftFree >= rightFree
        ? Math.max(0.1, leftFree / 2 / area.width)
        : Math.min(0.9, (win.right - area.left + rightFree / 2) / area.width);
    active().centerOn(id, true, fx);
  };

  // Pinned copies: kept on screen with their content, up to 3; the main window keeps following.
  const pinned: FloatingCode[] = [];
  const syncPins = (): void => flowsCode?.setPinEnabled(pinned.length < 3);
  const pinCurrent = (): void => {
    const v = flowsCode?.view;
    if (!flowsCode || !v || pinned.length >= 3) return;
    // Side by side to the left of the main window when there is room, else cascaded.
    const r = flowsCode.rectNow;
    const area = canvas.getBoundingClientRect();
    const n = pinned.length + 1;
    const w = Math.min(r.w, Math.max(260, Math.round((r.x - area.left - 12 * n) / n)));
    const fits = r.x - n * (w + 12) >= area.left;
    const copy = new FloatingCode(source, {
      pinned: true,
      rect: fits
        ? { x: r.x - n * (w + 12), y: r.y, w, h: r.h }
        : {
            x: area.left + 16 + 32 * (n - 1),
            y: area.top + 16 + 32 * (n - 1),
            w: Math.min(r.w, 420),
            h: r.h,
          },
    });
    copy.onShowInGraph = (id) => void selectNode(id);
    copy.onOpenFile = (path) => {
      const fv = fileView(index, `file:${path}`);
      if (fv) void copy.showView(fv);
    };
    copy.onClose = () => {
      pinned.splice(pinned.indexOf(copy), 1);
      copy.el.remove();
      syncPins();
    };
    document.body.append(copy.el);
    pinned.push(copy);
    void copy.showView(v).then(() => flowsCode.raise()); // the live window stays in front
    syncPins();
  };
  // Dock: hand the code over to the Code tab; Pop out: the reverse.
  const dockCode = (): void => {
    flowsCode?.close();
    if (state.flows) setFlows(false);
    if (panels.prefs.right === "collapsed") panels.setMode("right", "docked");
    openPanel("code");
  };
  const popOutCode = (): void => {
    if (!flowsCode) return;
    state.panel = "inspector";
    if (!flowsUi.code) setCodeView(true);
    else {
      forceCode = true;
      codeKey = "";
      paint();
    }
    writeHash();
  };
  if (flowsCode) {
    flowsCode.area = () => canvas.getBoundingClientRect();
    flowsCode.onPin = pinCurrent;
    flowsCode.onDock = dockCode;
  }
  const codeSw = codeSwitch({
    on: flowsUi.code,
    unavailable: flowsCode ? undefined : CODE_UNAVAILABLE,
    onToggle: (on) => setCodeView(on),
  });
  function setCodeView(on: boolean): void {
    flowsUi.code = on;
    codeSw.set(on);
    try {
      window.localStorage.setItem("buildrax:code-view", on ? "on" : "off");
    } catch {
      /* not remembered */
    }
    codeKey = "";
    if (!on) flowsCode?.close();
    if (state.flows) paintFlows();
    else if (on) {
      forceCode = true;
      paint();
    }
  }
  const legendBox = h("div", { class: "legend", "aria-label": "Color legend" });
  const statsBox = h("div", { class: "stats" });
  const minimap = h("canvas", { class: "minimap", width: 168, height: 112, "aria-hidden": "true" });
  scene.attachMinimap(minimap);
  blueprint.attachMinimap(minimap);
  const minimapWrap = h("div", { class: "minimap-wrap" }, minimap);
  const canvas = h(
    "main",
    { class: "canvas" },
    svg,
    bpSvg,
    costBox,
    flowsBox,
    legendBox,
    statsBox,
    minimapWrap,
    h(
      "div",
      { class: "zoom" },
      ...(["+", "−"] as const).map((t) => {
        const b = h(
          "button",
          { type: "button", "aria-label": t === "+" ? "Zoom in" : "Zoom out" },
          t,
        );
        b.addEventListener("click", () => active().zoomBy(t === "+" ? 1.25 : 0.8));
        return b;
      }),
    ),
  );
  const bodyEl = h("div", { class: "body" }, left, canvas, right);

  // Top bar keeps only what is used all the time; everything else lives in the menu.
  const menuSection = (title: string, ...kids: (Node | null)[]): HTMLElement =>
    h("section", { class: "menu-section" }, h("h4", null, title), ...kids);
  const field = (label: string, control: HTMLElement): HTMLElement =>
    h("label", { class: "menu-field" }, h("span", null, label), control);
  const check = (box: HTMLInputElement, label: string, hint: string): HTMLElement =>
    h("label", { class: "menu-check" }, box, h("span", null, label, h("small", null, hint)));
  const menuPanel = h(
    "div",
    { class: "menu-panel", role: "dialog", "aria-label": "View options", hidden: "" },
    menuSection(
      "Display",
      field("Color by", colorSel),
      field("Lineage depth", depthSel),
      h(
        "label",
        { class: "menu-field graph-only" },
        h("span", null, "Graph layout"),
        h(
          "div",
          { class: "seg small", role: "radiogroup", "aria-label": "Graph layout" },
          segLayered,
          segForce,
        ),
      ),
      field("Theme", themeBtn),
    ),
    menuSection(
      "Show",
      check(clusterBox, "Segment boxes", "Dotted boxes around services and folders"),
      check(extBox, "External dependencies", "npm / PyPI packages"),
      check(unrBox, "Unresolved imports", "Imports BuildRAX could not resolve"),
      check(motionBox, "Motion", "Animations, physics and flow"),
    ),
    menuSection("Graph", h("div", { class: "menu-actions" }, collapseBtn, shakeBtn, unpinBtn)),
    menuSection(
      "Shortcuts",
      h(
        "dl",
        { class: "shortcuts" },
        ...[
          ["/", "Search"],
          ["V", "Switch Graph / Nodes view"],
          ["E", "Flows view (endpoints)"],
          ["K", "Code view on/off"],
          ["C", "Cost view"],
          ["F", "Focus on the selection"],
          ["[  ]", "Overview / Inspector panel"],
          ["M", "Minimap"],
          ["Esc", "Close / clear selection"],
        ].flatMap(([k, v]) => [h("dt", null, h("kbd", null, k!)), h("dd", null, v!)]),
      ),
    ),
  );
  const menuBtn = h(
    "button",
    { type: "button", class: "menu-btn", "aria-haspopup": "dialog", "aria-expanded": "false" },
    s(
      "svg",
      { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
      s("path", { d: "M2.5 4 H13.5 M2.5 8 H13.5 M2.5 12 H13.5" }),
    ),
    "Menu",
  );
  const menuWrap = h("div", { class: "menu-wrap" }, menuBtn, menuPanel);
  const setMenu = (open: boolean): void => {
    menuPanel.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", () => setMenu(menuPanel.hidden));
  document.addEventListener("pointerdown", (ev) => {
    if (!menuPanel.hidden && !menuWrap.contains(ev.target as Node)) setMenu(false);
  });

  const focusName = h("strong", null, "");
  const focusDepth = h("span", { class: "muted" }, "");
  const focusExit = h(
    "button",
    { type: "button", class: "focus-exit", "aria-label": "Exit focus" },
    "Exit",
  );
  const focusPill = h(
    "div",
    { class: "focus-pill", role: "status", hidden: "" },
    h("span", { class: "focus-label" }, "Focus"),
    focusName,
    focusDepth,
    focusExit,
  );

  root.replaceChildren(
    h(
      "header",
      { class: "top" },
      h("h1", null, h("span", { class: "logo" }), "BUILDRAX"),
      h("div", { class: "search" }, searchInput, results),
      h(
        "div",
        { class: "seg view-seg", role: "radiogroup", "aria-label": "View" },
        segGraph,
        segNodes,
        segFlows,
        segCost,
      ),
      focusPill,
      h("div", { class: "top-right" }, codeSw.el, fitBtn, menuWrap),
    ),
    bodyEl,
  );

  // ---- collapsible / detachable panels, minimap and legend visibility ----
  const panels = new Panels(
    {
      body: bodyEl,
      canvas,
      left,
      right,
      leftActions,
      rightActions,
      leftHandle: leftHead,
      rightHandle: rightHead,
      minimapWrap,
      legend: legendBox,
    },
    () => active().wakeMinimap(),
  );
  canvas.querySelector(".zoom")?.append(panels.minimapToggle);

  // ---- state helpers ----
  const setTheme = (): void => {
    if (state.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = state.theme;
  };
  const writeHash = (): void => {
    try {
      history.replaceState(null, "", `#${encodeState(state)}`);
    } catch {
      /* e.g. sandboxed iframe: state just won't be shareable */
    }
  };
  const hideKinds = (): Set<NodeKind> => {
    const k = new Set<NodeKind>();
    if (!state.showExternal) k.add("external");
    if (!state.showUnresolved) k.add("unresolved");
    return k;
  };

  // ---- drawing ----
  const paint = (): void => {
    const sel = state.selected;
    const lineage =
      sel?.type === "node" && view.nodes.some((n) => n.id === sel.id)
        ? computeLineage(view, sel.id, state.depth)
        : undefined;
    if ((sel?.type === "node" ? sel.id : "") !== trace.for) {
      stopTrace();
      trace.for = sel?.type === "node" ? sel.id : "";
      trace.step = 0;
    }
    const steps = lineage ? buildTrace(view, lineage, trace.direction) : [];
    const maxStep = steps.reduce((m, st) => Math.max(m, st.n), 0);
    if (trace.step > maxStep) trace.step = 0;
    // Highlight only the direction and steps the user is looking at.
    const shown = lineage ? limitLineage(lineage, trace.direction, trace.step) : undefined;
    const visibleSteps = steps.filter((st) => trace.step === 0 || st.n <= trace.step);
    scene.setHighlight({ selected: sel, lineage: shown, focusKey });
    blueprint.setHighlight({
      selected: sel,
      lineage: shown,
      focusKey,
      steps: stepNumbers(visibleSteps),
    });
    renderInspector(inspectorBox, {
      index,
      view,
      selected: sel,
      expanded: new Set(state.expanded),
      onSelectNode: (id) => void selectNode(id),
      onExpand: (id) => void expand(id),
      onCollapse: (id) => void collapse(id),
      onFocus: (id) => void (state.focus === id ? exitFocus() : setFocus(id)),
      focusId: state.focus,
      cyclesFor,
    });
    if (sel?.type === "node" && lineage) {
      put(
        inspectorBox,
        renderTraceSection({
          steps,
          step: trace.step,
          direction: trace.direction,
          playing: trace.playing,
          nameOf: (id) => index.node(id)?.name ?? id,
          onDirection: (d) => {
            trace.direction = d;
            trace.step = 0;
            paint();
          },
          onStep: (n) => {
            stopTrace();
            trace.step = n;
            paint();
          },
          onPlay: () => {
            if (trace.playing) {
              stopTrace();
              return paint();
            }
            trace.playing = true;
            trace.step = 1;
            paint();
            trace.timer = window.setInterval(() => {
              if (trace.step >= maxStep) {
                stopTrace();
                trace.step = 0;
              } else trace.step++;
              paint();
            }, 1400);
          },
          onPick: (link, st) => {
            stopTrace();
            trace.step = st.n;
            paint();
            active().centerOn(st.direction === "downstream" ? link.to : link.from, true);
          },
        }),
      );
    }
    if (sel?.type === "node")
      put(
        inspectorBox,
        renderCostSection(costData, model, costUi.edits, sel.id, () => setCost(true)),
        renderResearchSection(research, index, sel.id),
      );
    if (sel) put(inspectorBox, renderNotesSection({ type: sel.type, id: sel.id }, store, index));
    scene.setBadges(nodeBadges(store.list(), index), edgeBadges(store.list()));
    blueprint.setBadges(nodeBadges(store.list(), index));
    renderNotesPanel(notesBox, {
      store,
      model,
      index,
      selectedNodeId: sel?.type === "node" ? sel.id : undefined,
      onJump: (note) => void jumpToNote(note.target),
    });
    syncTabs();
    syncCanvasCode(sel, steps);
    if (state.panel === "code") {
      const my = ++codeSeq;
      renderCodePanel(
        codeBox,
        {
          index,
          source,
          selected: sel,
          edge: (id) => view.edges.find((e) => e.id === id),
          onSelectNode: (id) => void selectNode(id),
        },
        () => my === codeSeq,
      );
    }
  };

  const syncTabs = (): void => {
    const code = state.panel === "code";
    inspectorBox.hidden = code;
    codeBox.hidden = !code;
    tabInspector.setAttribute("aria-selected", String(!code));
    tabCode.setAttribute("aria-selected", String(code));
    document.body.classList.toggle("code-open", code);
    popOutBtn.hidden = !code || !flowsCode;
  };
  const openPanel = (panel: "inspector" | "code"): void => {
    state.panel = panel;
    paint();
    writeHash();
  };
  tabInspector.addEventListener("click", () => openPanel("inspector"));
  tabCode.addEventListener("click", () => openPanel("code"));

  async function jumpToNote(target: { type: "node" | "edge"; id: string }): Promise<void> {
    if (target.type === "node") return selectNode(target.id);
    const [from, to] = target.id.split("=>");
    if (from) ensureVisible(from);
    if (to) ensureVisible(to);
    state.selected = { type: "edge", id: target.id };
    await refresh({ fit: true });
  }

  const maxDegree = Math.max(1, ...model.nodes.map((n) => index.fanIn(n.id) + index.fanOut(n.id)));
  const hues = packageHues(index);
  const hueOf = (containerId: string): number => {
    const pkg = packageOf(index, containerId);
    return (pkg ? hues.get(pkg) : undefined) ?? 215;
  };
  let groups: Groups = { specs: [], groupOf: new Map() };

  const styleFor = (v: GraphView, mode: ColorMode): Map<string, NodeStyle> => {
    const out = new Map<string, NodeStyle>();
    for (const vn of v.nodes) {
      const node = index.node(vn.id)!;
      const sw = swatchFor(
        { id: vn.id, kind: vn.kind, language: node.language },
        mode,
        { index, maxDegree },
        hues,
      );
      const degree = index.fanIn(vn.id) + index.fanOut(vn.id);
      out.set(vn.id, {
        hue: sw.hue,
        sat: sw.sat,
        key: sw.key,
        r: radiusFor(vn.kind, vn.fileCount, degree),
        group: groups.groupOf.get(vn.id),
      });
    }
    return out;
  };

  const renderLegend = (): void => {
    const entries = legendFor(
      view.nodes.map((n) => ({ id: n.id, kind: n.kind, language: index.node(n.id)?.language })),
      state.color,
      { index, maxDegree },
      hues,
    );
    const minBtn = iconButton(
      panels.prefs.legend ? "min" : "plus",
      panels.prefs.legend ? "Minimize the legend" : "Expand the legend",
    );
    minBtn.addEventListener("click", () => {
      panels.setLegend(!panels.prefs.legend);
      renderLegend();
    });
    legendBox.replaceChildren(
      h("div", { class: "legend-title" }, h("span", null, `Color: ${state.color}`), minBtn),
      ...entries.slice(0, 10).map((e) => {
        const b = h(
          "button",
          {
            type: "button",
            class: `legend-item${focusKey === e.key ? " on" : ""}`,
            style: `--h:${e.hue};--s:${e.sat}%`,
            title: "Click to focus this color",
          },
          h("i", { class: "swatch" }),
          h("span", null, e.label),
          h("em", null, String(e.count)),
        );
        b.addEventListener("click", () => {
          focusKey = focusKey === e.key ? undefined : e.key;
          paint();
          renderLegend();
        });
        return b;
      }),
    );
    statsBox.replaceChildren(
      h("span", null, h("b", null, String(view.nodes.length)), " nodes"),
      h("span", null, h("b", null, String(view.edges.length)), " links"),
      h(
        "span",
        { class: cycles.length ? "bad" : "" },
        h("b", null, String(cycles.length)),
        ` cycle${cycles.length === 1 ? "" : "s"}`,
      ),
      h(
        "span",
        null,
        state.view === "nodes"
          ? state.focus
            ? "nodes · focus"
            : "nodes"
          : state.focus
            ? "graph · focus"
            : state.layout === "force"
              ? "live physics"
              : "layered",
      ),
    );
  };

  async function refresh(opts: { fit?: boolean; center?: string } = {}): Promise<void> {
    const my = ++seq;
    const full = buildView(index, { expanded: new Set(state.expanded), hideKinds: hideKinds() });
    if (state.focus && !full.nodes.some((n) => n.id === state.focus)) state.focus = undefined;
    // Node view: only the focused node and its upstream/downstream neighbourhood, in columns.
    const focusLineage = state.focus ? computeLineage(full, state.focus, state.depth) : undefined;
    view = focusLineage ? focusView(full, focusLineage) : full;
    const boxes = state.cluster && !focusLineage;
    groups = boxes
      ? buildGroups(index, view, new Set(state.expanded), hueOf)
      : { specs: [], groupOf: new Map() };
    const style = styleFor(view, state.color);
    const radii = new Map([...style].map(([id, st]) => [id, st.r] as const));
    const nodesView = state.view === "nodes";
    // Nodes view: structured cards in frames with routed arrows. Graph view: orbs and physics.
    const blueprintL = nodesView
      ? await blueprintLayout(view, boxes ? groups : undefined)
      : undefined;
    const positions = nodesView
      ? new Map()
      : focusLineage
        ? nodeViewLayout(view, focusLineage, radii)
        : await layoutView(view, radii, boxes ? groups : undefined);
    if (my !== seq) return;
    syncFocus();
    syncView();
    if (state.selected?.type === "node" && !view.nodes.some((n) => n.id === state.selected!.id))
      state.selected = undefined;
    if (blueprintL) {
      blueprint.setGraph(
        { view, layout: blueprintL, style, groups: groups.specs },
        { fit: opts.fit },
      );
    } else {
      scene.setMotion(state.motion);
      scene.setGraph(
        {
          view,
          mode: focusLineage ? "layered" : state.layout,
          positions,
          style,
          ancestors: (id) => index.ancestors(id),
          groups: groups.specs,
          cluster: boxes,
        },
        { fit: opts.fit },
      );
    }
    paint();
    renderLegend();
    if (opts.center) {
      const id = opts.center;
      if (nodesView || state.layout === "layered") active().centerOn(id, true);
      else setTimeout(() => scene.centerOn(id, true), 500);
    }
    writeHash();
  }

  /** Show the canvas of the current view; only it draws the minimap. */
  function syncView(): void {
    const nodes = state.view === "nodes";
    const cost = state.cost;
    const flows = state.flows && !cost;
    const overlay = cost || flows;
    document.body.classList.toggle("view-nodes", nodes);
    // Both overlays hide the canvas the same way (view-cost styles).
    document.body.classList.toggle("view-cost", overlay);
    scene.setActive(!nodes && !overlay);
    blueprint.setActive(nodes && !overlay);
    costBox.hidden = !cost;
    flowsBox.hidden = !flows;
    segGraph.setAttribute("aria-checked", String(!nodes && !overlay));
    segNodes.setAttribute("aria-checked", String(nodes && !overlay));
    segFlows.setAttribute("aria-checked", String(flows));
    segCost.setAttribute("aria-checked", String(cost));
  }
  function setView(v: ViewState["view"]): void {
    const wasCost = state.cost || state.flows;
    state.cost = false;
    state.flows = false;
    if (state.view === v) {
      if (wasCost) {
        syncView();
        writeHash();
      }
      return;
    }
    state.view = v;
    void refresh({ fit: true });
  }
  const paintCost = (): void => {
    renderCostView(costBox, {
      data: costData,
      model,
      ui: costUi,
      onChange: () => {
        paintCost();
        paint();
      },
      onSelectNode: (id) => {
        setCost(false);
        void selectNode(id);
      },
    });
  };
  /** The Cost view covers the canvas; the graph underneath keeps its state. */
  function setCost(on: boolean): void {
    state.cost = on;
    if (on) flowsCode?.close();
    if (on) {
      state.flows = false;
      paintCost();
    }
    syncView();
    writeHash();
  }
  const paintFlows = (): void => {
    renderFlowsView(flowsBox, {
      index,
      ui: flowsUi,
      onChange: () => {
        state.route = flowsUi.route;
        paintFlows();
        writeHash();
      },
      onSelectNode: (id) => {
        setFlows(false);
        void selectNode(id);
      },
      codeWindow: flowsCode,
      codeUnavailable: flowsCode ? undefined : CODE_UNAVAILABLE,
    });
  };
  if (flowsCode) {
    flowsCode.onShowInGraph = (id) => {
      if (state.flows) {
        flowsCode.close();
        setFlows(false);
      }
      void selectNode(id);
    };
    flowsCode.onClose = () => {
      closedCodeKey = codeKey;
      if (flowsUi.picked) {
        flowsUi.picked = undefined;
        if (state.flows) paintFlows();
      }
    };
    flowsCode.onOpenFile = (path) => {
      const v = fileView(index, `file:${path}`);
      if (v) void flowsCode.showView(v);
    };
  }
  /** The Flows view covers the canvas like Cost; the graph keeps its state. */
  function setFlows(on: boolean): void {
    state.flows = on;
    flowsCode?.close(); // the canvas and Flows each open their own content
    codeKey = "";
    if (on) {
      state.cost = false;
      paintFlows();
    }
    syncView();
    writeHash();
  }

  const restyle = (): void => {
    const style = styleFor(view, state.color);
    scene.restyle(style);
    blueprint.restyle(style);
    renderLegend();
    writeHash();
  };

  function ensureVisible(id: string): void {
    const n = index.node(id);
    if (n?.kind === "external") state.showExternal = true;
    if (n?.kind === "unresolved") state.showUnresolved = true;
    for (const a of index.ancestors(id)) {
      if (index.node(a)?.kind === "module" && !state.expanded.includes(a)) state.expanded.push(a);
    }
  }
  async function selectNode(id: string): Promise<void> {
    ensureVisible(id);
    state.selected = { type: "node", id };
    syncControls();
    await refresh({ center: id });
  }
  /** Focus on a node: only it and its neighbourhood (or move the focus while already focused). */
  async function setFocus(id: string): Promise<void> {
    ensureVisible(id);
    state.focus = id;
    state.selected = { type: "node", id };
    syncControls();
    await refresh({ fit: true });
  }
  async function exitFocus(): Promise<void> {
    const back = state.focus;
    state.focus = undefined;
    if (back) state.selected = { type: "node", id: back };
    await refresh({ fit: true, center: back });
  }
  function syncFocus(): void {
    const on = !!state.focus;
    focusPill.hidden = !on;
    document.body.classList.toggle("focus-mode", on);
    if (on) {
      focusName.textContent = index.node(state.focus!)?.name ?? state.focus!;
      focusDepth.textContent =
        state.depth > 0 ? `${state.depth} hop${state.depth === 1 ? "" : "s"}` : "all hops";
    }
  }
  focusExit.addEventListener("click", () => void exitFocus());

  async function expand(id: string): Promise<void> {
    if (!state.expanded.includes(id)) state.expanded.push(id);
    state.selected = undefined;
    await refresh({ fit: true });
  }
  async function collapse(id: string): Promise<void> {
    const drop = new Set([id, ...index.descendants(id)]);
    state.expanded = state.expanded.filter((x) => !drop.has(x));
    state.selected = { type: "node", id };
    await refresh({ fit: true });
  }
  function setLayout(layout: ViewState["layout"]): void {
    state.layout = layout;
    syncControls();
    void refresh({ fit: true });
  }
  function syncControls(): void {
    depthSel.value = String(state.depth);
    colorSel.value = state.color;
    clusterBox.checked = state.cluster;
    motionBox.checked = state.motion;
    segLayered.setAttribute("aria-checked", String(state.layout === "layered"));
    segForce.setAttribute("aria-checked", String(state.layout === "force"));
    document.body.dataset.layout = state.layout;
    extBox.checked = state.showExternal;
    unrBox.checked = state.showUnresolved;
  }

  // ---- sidebar overview ----
  const nameOf = (id: string): string => index.node(id)?.name ?? id;
  const files = model.nodes.filter((n) => n.kind === "file").length;
  const linkTo = (id: string, text: string): HTMLElement => {
    const b = h("button", { class: "link", type: "button" }, text);
    b.addEventListener("click", () => void selectNode(id));
    return b;
  };
  leftBody.append(
    h(
      "p",
      { class: "muted" },
      `${files} files · ${model.meta.languages.join(", ") || "no languages"}`,
    ),
    h("h3", null, "Circular dependencies"),
    cycles.length
      ? h("ul", null, ...cycles.map((c) => h("li", null, linkTo(c[0]!, c.map(nameOf).join(" ↔ ")))))
      : h("p", { class: "muted" }, "none found"),
    h("h3", null, "Most connected files"),
    h(
      "ul",
      null,
      ...hubs(index, "file", 6).map((x) =>
        h(
          "li",
          null,
          linkTo(x.id, nameOf(x.id)),
          h("span", { class: "muted" }, ` in ${x.fanIn} / out ${x.fanOut}`),
        ),
      ),
    ),
  );

  put(leftBody, notesStatus, notesBox);
  store.subscribe(() => {
    relocateNotes(store, model);
    paint();
  });

  // ---- events ----
  window.addEventListener("keydown", (ev) => {
    // Never steal keys while the user is writing (search box, note editor, selects).
    const t = ev.target;
    const typing =
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable);
    if (ev.key === "Escape") {
      // Close the innermost thing first: menu, then node view, then the selection.
      if (!menuPanel.hidden) return setMenu(false);
      results.classList.remove("open");
      if (state.focus) return void exitFocus();
      state.selected = undefined;
      paint();
      writeHash();
    } else if ((ev.key === "f" || ev.key === "F") && !typing && !ev.ctrlKey && !ev.metaKey) {
      if (state.focus) void exitFocus();
      else if (state.selected?.type === "node") void setFocus(state.selected.id);
    } else if (ev.key === "/" && !typing) {
      ev.preventDefault();
      searchInput.focus();
    } else if (!typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.key === "[") panels.toggle("left");
      else if (ev.key === "]") panels.toggle("right");
      else if (ev.key === "m" || ev.key === "M") panels.setMinimap(!panels.prefs.minimap);
      else if (ev.key === "v" || ev.key === "V")
        setView(state.view === "nodes" ? "graph" : "nodes");
      else if (ev.key === "c" || ev.key === "C") setCost(!state.cost);
      else if (ev.key === "e" || ev.key === "E") setFlows(!state.flows);
      else if ((ev.key === "k" || ev.key === "K") && flowsCode) setCodeView(!flowsUi.code);
    }
  });
  searchInput.addEventListener("input", () => {
    const found = searchNodes(index, searchInput.value, 8);
    results.replaceChildren(
      ...found.map((n) => {
        const b = h(
          "button",
          { type: "button" },
          `${n.name}  `,
          h("span", { class: "muted" }, n.kind),
        );
        b.addEventListener("click", () => {
          results.classList.remove("open");
          void selectNode(n.id);
        });
        return b;
      }),
    );
    results.classList.toggle("open", found.length > 0);
  });
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") (results.firstElementChild as HTMLElement | null)?.click();
  });
  depthSel.addEventListener("change", () => {
    state.depth = Number(depthSel.value);
    // In node view the depth decides which neighbours are shown, so rebuild it.
    if (state.focus) return void refresh({ fit: true });
    paint();
    writeHash();
  });
  extBox.addEventListener("change", () => {
    state.showExternal = extBox.checked;
    void refresh({ fit: true });
  });
  unrBox.addEventListener("change", () => {
    state.showUnresolved = unrBox.checked;
    void refresh({ fit: true });
  });
  collapseBtn.addEventListener("click", () => {
    state.expanded = [];
    state.selected = undefined;
    void refresh({ fit: true });
  });
  fitBtn.addEventListener("click", () => active().fit(true));
  segGraph.addEventListener("click", () => setView("graph"));
  segNodes.addEventListener("click", () => setView("nodes"));
  segCost.addEventListener("click", () => setCost(true));
  segFlows.addEventListener("click", () => setFlows(true));
  shakeBtn.addEventListener("click", () => scene.reheat());
  unpinBtn.addEventListener("click", () => scene.unpinAll());
  segLayered.addEventListener("click", () => setLayout("layered"));
  segForce.addEventListener("click", () => setLayout("force"));
  colorSel.addEventListener("change", () => {
    state.color = colorSel.value as ColorMode;
    focusKey = undefined;
    restyle();
    paint();
  });
  clusterBox.addEventListener("change", () => {
    state.cluster = clusterBox.checked;
    void refresh({ fit: true });
  });
  motionBox.addEventListener("change", () => {
    state.motion = motionBox.checked;
    void refresh({ fit: true });
  });
  themeBtn.addEventListener("click", () => {
    state.theme = state.theme === "auto" ? "dark" : state.theme === "dark" ? "light" : "auto";
    themeBtn.textContent =
      state.theme === "dark" ? "Dark" : state.theme === "light" ? "Light" : "Auto (system)";
    setTheme();
    writeThemePref(state.theme);
    writeHash();
  });

  themeBtn.textContent =
    state.theme === "dark" ? "Dark" : state.theme === "light" ? "Light" : "Auto (system)";
  setTheme();
  syncControls();
  startLiveUpdates(readJson("buildrax-config") as LiveConfig | undefined);
  void refresh({ fit: true }).then(() => {
    if (state.cost) setCost(true);
    else if (state.flows) setFlows(true);
  });
}

const embedded = readEmbedded();
if (embedded === undefined) showDropZone();
else {
  const result = validateModel(embedded);
  if (result.ok && result.model) start(result.model);
  else showDropZone(result.errors.slice(0, 10));
}
