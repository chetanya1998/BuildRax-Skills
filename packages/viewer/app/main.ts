import "./theme.css";
import "./scene.css";
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
import { radiusFor } from "./geometry.js";
import {
  COLOR_MODES,
  legendFor,
  packageHues,
  packageOf,
  swatchFor,
  type ColorMode,
} from "./palette.js";
import { Scene, type NodeStyle } from "./scene.js";
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

  const cycles = fileCycles(index);
  const cyclesFor = (id: string): string[][] => {
    const scope = new Set([id, ...index.descendants(id)]);
    return cycles.filter((c) => c.some((f) => scope.has(f)));
  };

  // ---- DOM skeleton ----
  const svg = s("svg", { class: "stage", role: "application", "aria-label": "Architecture graph" });
  const scene = new Scene(svg, {
    select: (sel) => {
      state.selected = sel;
      paint();
      writeHash();
    },
    expand: (id) => void expand(id),
  });

  const searchInput = h("input", {
    type: "search",
    placeholder: "Search ( / )",
    "aria-label": "Search architecture",
  });
  const results = h("div", { class: "results" });
  const select = (label: string, opts: [string, string][]): HTMLSelectElement =>
    h("select", { "aria-label": label }, ...opts.map(([v, t]) => h("option", { value: v }, t)));
  const depthSel = select("Lineage depth", [
    ["1", "depth 1"],
    ["2", "depth 2"],
    ["3", "depth 3"],
    ["0", "depth ∞"],
  ]);
  const colorSel = select(
    "Color by",
    COLOR_MODES.map((c) => [c, `color: ${c}`]),
  );
  const segLayered = h("button", { type: "button", role: "radio" }, "Layered");
  const segForce = h("button", { type: "button", role: "radio" }, "Live");
  const clusterBox = h("input", { type: "checkbox" });
  const motionBox = h("input", { type: "checkbox" });
  const extBox = h("input", { type: "checkbox" });
  const unrBox = h("input", { type: "checkbox" });
  const themeBtn = h("button", { type: "button" }, "Theme");
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
  const collapseBtn = h("button", { type: "button" }, "Collapse");
  const left = h("aside", { class: "left" });
  const notesStatus = h("p", { class: "warn", role: "status" });
  const notesBox = h("div", { class: "notes-box" });
  const research = parseResearch(readJson("buildrax-research"));
  const store = createStore(model, (msg) => void (notesStatus.textContent = msg));
  const inspectorBox = h("div", { class: "tab-body", "aria-live": "polite" });
  const codeBox = h("div", { class: "tab-body code-box" });
  const tabInspector = h("button", { type: "button", role: "tab" }, "Inspector");
  const tabCode = h("button", { type: "button", role: "tab" }, "Code");
  const right = h(
    "aside",
    { class: "right" },
    h("div", { class: "tabs", role: "tablist" }, tabInspector, tabCode),
    inspectorBox,
    codeBox,
  );
  const source = createCodeSource(
    readJson("buildrax-config") as { server?: boolean; token?: string } | undefined,
    readJson("buildrax-sources"),
    (url, init) => fetch(url, init),
  );
  let codeSeq = 0;
  const legendBox = h("div", { class: "legend", "aria-label": "Color legend" });
  const statsBox = h("div", { class: "stats" });
  const minimap = h("canvas", { class: "minimap", width: 168, height: 112, "aria-hidden": "true" });
  scene.attachMinimap(minimap);
  const canvas = h(
    "main",
    { class: "canvas" },
    svg,
    legendBox,
    statsBox,
    minimap,
    h(
      "div",
      { class: "zoom" },
      ...(["+", "−"] as const).map((t) => {
        const b = h(
          "button",
          { type: "button", "aria-label": t === "+" ? "Zoom in" : "Zoom out" },
          t,
        );
        b.addEventListener("click", () => scene.zoomBy(t === "+" ? 1.25 : 0.8));
        return b;
      }),
    ),
  );
  root.replaceChildren(
    h(
      "header",
      { class: "top" },
      h("h1", null, h("span", { class: "logo" }), "BUILDRAX"),
      h("div", { class: "search" }, searchInput, results),
      h("div", { class: "seg", role: "radiogroup", "aria-label": "Layout" }, segLayered, segForce),
      colorSel,
      depthSel,
      h(
        "label",
        { class: "chip", title: "Pull each package's files together" },
        clusterBox,
        "clusters",
      ),
      h("label", { class: "chip", title: "Animations and physics" }, motionBox, "motion"),
      h("label", { class: "chip" }, extBox, "externals"),
      h("label", { class: "chip" }, unrBox, "unresolved"),
      collapseBtn,
      shakeBtn,
      unpinBtn,
      fitBtn,
      themeBtn,
    ),
    h("div", { class: "body" }, left, canvas, right),
  );

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
    scene.setHighlight({ selected: sel, lineage, focusKey });
    renderInspector(inspectorBox, {
      index,
      view,
      selected: sel,
      expanded: new Set(state.expanded),
      onSelectNode: (id) => void selectNode(id),
      onExpand: (id) => void expand(id),
      onCollapse: (id) => void collapse(id),
      cyclesFor,
    });
    if (sel?.type === "node") put(inspectorBox, renderResearchSection(research, index, sel.id));
    if (sel) put(inspectorBox, renderNotesSection({ type: sel.type, id: sel.id }, store, index));
    scene.setBadges(nodeBadges(store.list(), index), edgeBadges(store.list()));
    renderNotesPanel(notesBox, {
      store,
      model,
      index,
      selectedNodeId: sel?.type === "node" ? sel.id : undefined,
      onJump: (note) => void jumpToNote(note.target),
    });
    syncTabs();
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
  };
  const openPanel = (panel: "inspector" | "code"): void => {
    state.panel = panel;
    paint();
    writeHash();
    // The canvas width changes with the panel, so refit once layout has settled.
    requestAnimationFrame(() => scene.fit(true));
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
  const groups = new Map(
    [...hues].map(([id, hue]) => [id, { label: index.node(id)?.name ?? id, hue }] as const),
  );

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
        group: packageOf(index, vn.id),
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
    legendBox.replaceChildren(
      h("div", { class: "legend-title" }, `Color: ${state.color}`),
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
      h("span", null, state.layout === "force" ? "live physics" : "layered"),
    );
  };

  async function refresh(opts: { fit?: boolean; center?: string } = {}): Promise<void> {
    const my = ++seq;
    view = buildView(index, { expanded: new Set(state.expanded), hideKinds: hideKinds() });
    const style = styleFor(view, state.color);
    const radii = new Map([...style].map(([id, st]) => [id, st.r] as const));
    const positions = await layoutView(view, radii);
    if (my !== seq) return;
    if (state.selected?.type === "node" && !view.nodes.some((n) => n.id === state.selected!.id))
      state.selected = undefined;
    scene.setMotion(state.motion);
    scene.setGraph(
      {
        view,
        mode: state.layout,
        positions,
        style,
        ancestors: (id) => index.ancestors(id),
        groups,
        cluster: state.cluster,
      },
      { fit: opts.fit },
    );
    paint();
    renderLegend();
    if (opts.center) {
      const id = opts.center;
      if (state.layout === "layered") scene.centerOn(id, true);
      else setTimeout(() => scene.centerOn(id, true), 500);
    }
    writeHash();
  }

  const restyle = (): void => {
    const style = styleFor(view, state.color);
    scene.restyle(style, groups);
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
  left.append(
    h("h3", null, "Overview"),
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

  put(left, notesStatus, notesBox);
  store.subscribe(() => {
    relocateNotes(store, model);
    paint();
  });

  // ---- events ----
  window.addEventListener("keydown", (ev) => {
    const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement;
    if (ev.key === "Escape") {
      state.selected = undefined;
      results.classList.remove("open");
      paint();
      writeHash();
    } else if (ev.key === "/" && !typing) {
      ev.preventDefault();
      searchInput.focus();
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
  fitBtn.addEventListener("click", () => scene.fit(true));
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
      state.theme === "dark"
        ? "Theme: dark"
        : state.theme === "light"
          ? "Theme: light"
          : "Theme: auto";
    setTheme();
    writeThemePref(state.theme);
    writeHash();
  });
  window.addEventListener("resize", () => scene.fit(false));

  themeBtn.textContent =
    state.theme === "dark"
      ? "Theme: dark"
      : state.theme === "light"
        ? "Theme: light"
        : "Theme: auto";
  setTheme();
  syncControls();
  void refresh({ fit: true });
}

const embedded = readEmbedded();
if (embedded === undefined) showDropZone();
else {
  const result = validateModel(embedded);
  if (result.ok && result.model) start(result.model);
  else showDropZone(result.errors.slice(0, 10));
}
