import "./theme.css";
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
import { renderInspector } from "./inspector.js";
import { edgeBadges, nodeBadges } from "./notes-logic.js";
import { LocalStorageStore, ServerStore, type NotesStore } from "./notes-store.js";
import {
  paintNoteBadges,
  relocateNotes,
  renderNotesPanel,
  renderNotesSection,
} from "./notes-ui.js";
import { layoutView, type Layout } from "./layout.js";
import { computeLineage } from "./lineage.js";
import { parseResearch, renderResearchSection } from "./research-ui.js";
import { defs, gridRect, paintHighlight, renderGraph } from "./render.js";
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
  let view: GraphView = { nodes: [], edges: [] };
  let layout: Layout = { nodes: new Map(), edges: new Map(), width: 0, height: 0 };
  const tf = { x: 0, y: 0, k: 1 };
  let seq = 0;

  const cycles = fileCycles(index);
  const cyclesFor = (id: string): string[][] => {
    const scope = new Set([id, ...index.descendants(id)]);
    return cycles.filter((c) => c.some((f) => scope.has(f)));
  };

  // ---- DOM skeleton ----
  const svg = s("svg", { class: "stage", role: "application", "aria-label": "Architecture graph" });
  const viewport = s("g", { id: "viewport" });
  const content = s("g", { id: "content" });
  viewport.append(gridRect(), content);
  svg.append(defs(), viewport);

  const searchInput = h("input", {
    type: "search",
    placeholder: "Search ( / )",
    "aria-label": "Search architecture",
  });
  const results = h("div", { class: "results" });
  const depthSel = h(
    "select",
    { "aria-label": "Lineage depth" },
    ...[
      ["1", "depth 1"],
      ["2", "depth 2"],
      ["3", "depth 3"],
      ["0", "all"],
    ].map(([v, t]) => h("option", { value: v! }, t!)),
  );
  const extBox = h("input", { type: "checkbox" });
  const unrBox = h("input", { type: "checkbox" });
  const themeBtn = h("button", { type: "button" }, "Theme");
  const fitBtn = h("button", { type: "button" }, "Fit");
  const collapseBtn = h("button", { type: "button" }, "Collapse all");
  const left = h("aside", { class: "left" });
  const notesStatus = h("p", { class: "warn", role: "status" });
  const notesBox = h("div", { class: "notes-box" });
  const research = parseResearch(readJson("buildrax-research"));
  const store = createStore(model, (msg) => void (notesStatus.textContent = msg));
  const right = h("aside", { class: "right", "aria-live": "polite" });
  const canvas = h(
    "main",
    { class: "canvas" },
    svg,
    h(
      "div",
      { class: "zoom" },
      ...(["+", "−"] as const).map((t) => {
        const b = h(
          "button",
          { type: "button", "aria-label": t === "+" ? "Zoom in" : "Zoom out" },
          t,
        );
        b.addEventListener("click", () => zoomBy(t === "+" ? 1.25 : 0.8));
        return b;
      }),
    ),
    h(
      "div",
      { class: "titleblock" },
      h("b", null, model.meta.repo),
      `scanned ${model.meta.scannedAt}`,
      h("br"),
      `${model.schemaVersion} · ${model.nodes.length} nodes · ${model.edges.length} edges`,
      h("br"),
      `${cycles.length} cycle${cycles.length === 1 ? "" : "s"} · read-only`,
    ),
  );
  root.replaceChildren(
    h(
      "header",
      { class: "top" },
      h("h1", null, "BUILDRAX"),
      h("div", { class: "search" }, searchInput, results),
      depthSel,
      h("label", null, extBox, "externals"),
      h("label", null, unrBox, "unresolved"),
      collapseBtn,
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

  // ---- viewport ----
  const applyTf = (): void =>
    viewport.setAttribute("transform", `translate(${tf.x},${tf.y}) scale(${tf.k})`);
  const fit = (): void => {
    const r = svg.getBoundingClientRect();
    if (!layout.width || !r.width) return;
    const k = Math.min((r.width - 80) / layout.width, (r.height - 80) / layout.height, 1.5);
    tf.k = Math.max(0.1, k);
    tf.x = (r.width - layout.width * tf.k) / 2;
    tf.y = (r.height - layout.height * tf.k) / 2;
    applyTf();
  };
  const zoomAt = (px: number, py: number, factor: number): void => {
    const k2 = Math.min(3, Math.max(0.1, tf.k * factor));
    tf.x = px - ((px - tf.x) * k2) / tf.k;
    tf.y = py - ((py - tf.y) * k2) / tf.k;
    tf.k = k2;
    applyTf();
  };
  function zoomBy(factor: number): void {
    const r = svg.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, factor);
  }
  const centerOn = (id: string): void => {
    const n = layout.nodes.get(id);
    const r = svg.getBoundingClientRect();
    if (!n) return;
    tf.x = r.width / 2 - (n.x + n.w / 2) * tf.k;
    tf.y = r.height / 2 - (n.y + n.h / 2) * tf.k;
    applyTf();
  };

  // ---- drawing ----
  const paint = (): void => {
    const sel = state.selected;
    const lineage =
      sel?.type === "node" && view.nodes.some((n) => n.id === sel.id)
        ? computeLineage(view, sel.id, state.depth)
        : undefined;
    paintHighlight(content, { selected: sel, lineage });
    renderInspector(right, {
      index,
      view,
      selected: sel,
      expanded: new Set(state.expanded),
      onSelectNode: (id) => void selectNode(id),
      onExpand: (id) => void expand(id),
      onCollapse: (id) => void collapse(id),
      cyclesFor,
    });
    if (sel?.type === "node") put(right, renderResearchSection(research, index, sel.id));
    if (sel) put(right, renderNotesSection({ type: sel.type, id: sel.id }, store, index));
    paintNoteBadges(content, nodeBadges(store.list(), index), edgeBadges(store.list()));
    renderNotesPanel(notesBox, {
      store,
      model,
      index,
      selectedNodeId: sel?.type === "node" ? sel.id : undefined,
      onJump: (note) => void jumpToNote(note.target),
    });
  };

  async function jumpToNote(target: { type: "node" | "edge"; id: string }): Promise<void> {
    if (target.type === "node") return selectNode(target.id);
    const [from, to] = target.id.split("=>");
    if (from) ensureVisible(from);
    if (to) ensureVisible(to);
    state.selected = { type: "edge", id: target.id };
    await refresh({ fit: true });
  }

  async function refresh(opts: { fit?: boolean; center?: string } = {}): Promise<void> {
    const my = ++seq;
    view = buildView(index, { expanded: new Set(state.expanded), hideKinds: hideKinds() });
    const next = await layoutView(view);
    if (my !== seq) return;
    layout = next;
    if (state.selected?.type === "node" && !view.nodes.some((n) => n.id === state.selected!.id))
      state.selected = undefined;
    renderGraph(content, view, layout);
    paint();
    if (opts.fit) fit();
    if (opts.center) centerOn(opts.center);
    writeHash();
  }

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
  function syncControls(): void {
    depthSel.value = String(state.depth);
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
  let dragged = false;
  svg.addEventListener("pointerdown", (ev) => {
    dragged = false;
    const sx = ev.clientX,
      sy = ev.clientY,
      ox = tf.x,
      oy = tf.y;
    const move = (m: PointerEvent): void => {
      if (Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 4) dragged = true;
      if (dragged) {
        tf.x = ox + m.clientX - sx;
        tf.y = oy + m.clientY - sy;
        applyTf();
      }
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  svg.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
    },
    { passive: false },
  );
  svg.addEventListener("click", (ev) => {
    if (dragged) return;
    const t = ev.target as Element;
    const nodeEl = t.closest("[data-node]");
    const edgeEl = t.closest("[data-edge]");
    if (nodeEl) state.selected = { type: "node", id: nodeEl.getAttribute("data-node")! };
    else if (edgeEl) state.selected = { type: "edge", id: edgeEl.getAttribute("data-edge")! };
    else state.selected = undefined;
    paint();
    writeHash();
  });
  svg.addEventListener("dblclick", (ev) => {
    const id = (ev.target as Element).closest("[data-node]")?.getAttribute("data-node");
    if (id && view.nodes.find((n) => n.id === id)?.expandable) void expand(id);
  });
  svg.addEventListener("keydown", (ev) => {
    const id = (ev.target as Element).closest("[data-node]")?.getAttribute("data-node");
    if (!id) return;
    if (ev.key === "Enter") void selectNode(id);
    if (ev.key === " " && view.nodes.find((n) => n.id === id)?.expandable) {
      ev.preventDefault();
      void expand(id);
    }
  });
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
  fitBtn.addEventListener("click", fit);
  themeBtn.addEventListener("click", () => {
    state.theme = state.theme === "auto" ? "dark" : state.theme === "dark" ? "light" : "auto";
    themeBtn.textContent = `Theme: ${state.theme}`;
    setTheme();
    writeHash();
  });
  window.addEventListener("resize", fit);

  themeBtn.textContent = `Theme: ${state.theme}`;
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
