import { listRoutes, routeFlow, type Flow, type GraphIndex, type RouteInfo } from "@buildrax/graph";
import { h, s } from "./dom.js";

export interface FlowsUi {
  /** Selected route id. */
  route?: string;
  filter: string;
}

export interface FlowsViewOptions {
  index: GraphIndex;
  ui: FlowsUi;
  onChange: () => void;
  /** Leave the Flows view and select the node in the graph. */
  onSelectNode: (id: string) => void;
}

const METHOD_HUE: Record<string, number> = {
  GET: 150,
  POST: 210,
  PUT: 36,
  PATCH: 280,
  DELETE: 4,
  ANY: 230,
  PAGE: 190,
  WS: 320,
};
export const methodColor = (m: string): string => `hsl(${METHOD_HUE[m] ?? 220} 62% 46%)`;

/** Lanes, left to right: where each node of a flow is drawn. */
export type Lane = "endpoint" | "code" | "infra" | "package";

export interface FlowLayoutNode {
  id: string;
  label: string;
  sub: string;
  lane: Lane;
  /** Lane row index (endpoint, code hop 0…n, infrastructure, packages), top to bottom. */
  row: number;
  /** Position within the row (wraps every PER_ROW boxes onto a new line of the same lane). */
  slot: number;
  /** Lane title shown above the row. */
  title: string;
}

export const PER_ROW = 3;

/** Rows top to bottom: endpoint, code by hop, infrastructure, packages. Pure, for tests. */
export function layoutFlow(
  index: GraphIndex,
  flow: Flow,
): { nodes: FlowLayoutNode[]; rows: number } {
  const hopOf = new Map<string, number>([[flow.entry, 0]]);
  for (const st of flow.steps) if (!hopOf.has(st.to)) hopOf.set(st.to, st.hop);
  const nodes: FlowLayoutNode[] = [];
  let row = 0;
  const lane = (
    lane: Lane,
    title: string,
    items: { id: string; label: string; sub: string }[],
  ): void => {
    if (!items.length) return;
    items.forEach((it, i) => nodes.push({ ...it, lane, row, slot: i, title }));
    row++;
  };
  const r = flow.route;
  lane("endpoint", "Endpoint", [
    { id: r.id, label: `${r.method} ${r.path ?? "(computed)"}`, sub: r.framework },
  ]);
  const files = [...hopOf.entries()]
    .filter(([id]) => index.node(id)?.kind === "file")
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const maxHop = Math.max(0, ...files.map(([, h]) => h));
  for (let hop = 0; hop <= maxHop; hop++)
    lane(
      "code",
      hop === 0 ? "Handler file" : `Code · ${hop} hop${hop === 1 ? "" : "s"} away`,
      files
        .filter(([, h]) => h === hop)
        .map(([id]) => ({ id, label: index.node(id)!.name, sub: index.node(id)!.path ?? "" })),
    );
  lane(
    "infra",
    "Infrastructure",
    flow.participants.infra.map((id) => ({
      id,
      label: index.node(id)?.name ?? id,
      sub: index.node(id)?.kind ?? "",
    })),
  );
  lane(
    "package",
    "Packages",
    [...flow.participants.packages, ...flow.participants.external].map((id) => ({
      id,
      label: index.node(id)?.name ?? id,
      sub: index.node(id)?.kind === "module" ? "workspace package" : "package",
    })),
  );
  return { nodes, rows: row };
}

function routeList(routes: RouteInfo[], o: FlowsViewOptions): HTMLElement {
  const q = o.ui.filter.trim().toLowerCase();
  const shown = routes.filter(
    (r) =>
      !q || `${r.method} ${r.path ?? ""} ${r.framework} ${r.file ?? ""}`.toLowerCase().includes(q),
  );
  const input = h("input", {
    type: "search",
    placeholder: "Filter endpoints",
    value: o.ui.filter,
    "aria-label": "Filter endpoints",
  });
  input.addEventListener("input", () => {
    o.ui.filter = input.value;
    o.onChange();
    requestAnimationFrame(() => {
      const again = document.querySelector<HTMLInputElement>(".flows-list input[type=search]");
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });
  });
  const groups = new Map<string, RouteInfo[]>();
  for (const r of shown) {
    const key = r.type === "page" ? "Pages" : r.framework;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return h(
    "aside",
    { class: "flows-list" },
    h("h3", null, `Endpoints (${routes.length})`),
    input,
    ...[...groups.entries()].map(([g, list]) =>
      h(
        "section",
        null,
        h("h4", null, g),
        ...list.map((r) => {
          const b = h(
            "button",
            {
              type: "button",
              class: "flow-route",
              "aria-pressed": String(r.id === o.ui.route),
              title: `${r.file ?? ""}${r.line ? `:${r.line}` : ""}`,
            },
            h("span", { class: "method", style: `background:${methodColor(r.method)}` }, r.method),
            h("span", { class: "rpath" }, r.path ?? "(computed path)"),
          );
          b.addEventListener("click", () => {
            o.ui.route = r.id;
            o.onChange();
          });
          return b;
        }),
      ),
    ),
    shown.length ? null : h("p", { class: "muted" }, "No endpoint matches."),
  );
}

const W = 170;
const H = 44;
const GX = 22;
const LINE = H + 18; // one wrapped line of boxes
const TITLE = 22;
const LANE_GAP = 26;

function diagram(index: GraphIndex, flow: Flow, o: FlowsViewOptions): SVGSVGElement {
  const { nodes, rows } = layoutFlow(index, flow);
  // Vertical position of every lane (lanes with many boxes wrap onto extra lines).
  const laneTop: number[] = [];
  let y = 10;
  for (let r = 0; r < rows; r++) {
    laneTop.push(y);
    const count = nodes.filter((n) => n.row === r).length;
    y += TITLE + Math.ceil(count / PER_ROW) * LINE + LANE_GAP;
  }
  const width = PER_ROW * (W + GX) + 40; // right margin carries lane-skipping edges
  const height = y;
  const pos = new Map(
    nodes.map((n) => [
      n.id,
      {
        x: 6 + (n.slot % PER_ROW) * (W + GX),
        y: laneTop[n.row]! + TITLE + Math.floor(n.slot / PER_ROW) * LINE,
      },
    ]),
  );
  const svg = s("svg", {
    class: "flow-diagram",
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": `Flow of ${flow.route.method} ${flow.route.path ?? ""}`,
  });
  svg.append(
    s(
      "defs",
      null,
      s(
        "marker",
        {
          id: "flow-arrow",
          viewBox: "0 0 10 10",
          refX: 9,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          orient: "auto-start-reverse",
        },
        s("path", { d: "M0,0 L10,5 L0,10 z", class: "flow-arrowhead" }),
      ),
    ),
  );
  const titles: SVGElement[] = [];
  for (let r = 0; r < rows; r++) {
    const first = nodes.find((n) => n.row === r)!;
    titles.push(s("text", { x: 6, y: laneTop[r]! + 13, class: "lane-title" }, first.title));
  }
  const rowOf = new Map(nodes.map((n) => [n.id, n.row]));
  const edges: { from: string; to: string; n?: number }[] = [
    { from: flow.route.id, to: flow.entry },
  ];
  for (const st of flow.steps) edges.push({ from: st.from, to: st.to, n: st.n });
  const labels: SVGElement[] = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + W / 2;
    const y1 = a.y + H;
    const x2 = b.x + W / 2;
    const y2 = b.y - 2;
    // Next lane down: straight curve. Skipping lanes or going back: around the right side, so
    // the line never crosses another box.
    const adjacent = (rowOf.get(e.to) ?? 0) === (rowOf.get(e.from) ?? 0) + 1 && y2 > y1;
    const side = Math.max(a.x, b.x) + W + 16;
    const ya = a.y + H / 2;
    const yb = b.y + H / 2;
    const turn = yb > ya ? 6 : -6;
    const d = adjacent
      ? `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`
      : `M${a.x + W},${ya} H${side - 6} Q${side},${ya} ${side},${ya + turn} V${yb - turn} Q${side},${yb} ${side - 6},${yb} H${b.x + W + 2}`;
    svg.append(s("path", { d, class: "flow-edge", "marker-end": "url(#flow-arrow)" }));
    if (e.n !== undefined) {
      const mx = adjacent ? (x1 + x2) / 2 : side;
      const my = adjacent ? (y1 + y2) / 2 : (a.y + b.y + H) / 2;
      labels.push(
        s(
          "g",
          { class: "flow-step" },
          s("circle", { cx: mx, cy: my, r: 9 }),
          s("text", { x: mx, y: my + 3.5, "text-anchor": "middle" }, String(e.n)),
        ),
      );
    }
  }
  for (const n of nodes) {
    const p = pos.get(n.id)!;
    const g = s(
      "g",
      {
        class: `flow-node lane-${n.lane}`,
        transform: `translate(${p.x},${p.y})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${n.label} (${n.sub})`,
      },
      s("rect", { width: W, height: H, rx: 10 }),
      n.lane === "endpoint"
        ? s("rect", { width: 5, height: H, rx: 2, fill: methodColor(flow.route.method) })
        : null,
      s(
        "text",
        { x: 12, y: 18, class: "fn-label" },
        n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label,
      ),
      s(
        "text",
        { x: 12, y: 34, class: "fn-sub" },
        n.sub.length > 27 ? `…${n.sub.slice(-26)}` : n.sub,
      ),
      s("title", null, `${n.label}\n${n.sub}`),
    );
    const open = (): void => o.onSelectNode(n.lane === "endpoint" ? flow.entry : n.id);
    g.addEventListener("click", open);
    g.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") open();
    });
    svg.append(g);
  }
  svg.append(...titles, ...labels); // titles and step numbers on top of lines
  return svg;
}

function stepList(index: GraphIndex, flow: Flow): HTMLElement {
  const name = (id: string) => {
    const n = index.node(id);
    return n?.kind === "file" ? (n.path ?? n.name) : `${n?.name ?? id}${n ? ` (${n.kind})` : ""}`;
  };
  return h(
    "ol",
    { class: "flow-steps" },
    ...flow.steps.map((st) =>
      h(
        "li",
        null,
        h("span", { class: "muted" }, `hop ${st.hop} · `),
        `${name(st.from)} `,
        h("b", null, st.kind),
        ` → ${name(st.to)}`,
        st.evidence?.file
          ? h(
              "code",
              null,
              ` ${st.evidence.file}${st.evidence.startLine ? `:${st.evidence.startLine}` : ""}`,
            )
          : null,
      ),
    ),
  );
}

/** The whole Flows view. Read-only: picks and highlights, never edits the model. */
export function renderFlowsView(el: HTMLElement, o: FlowsViewOptions): void {
  const routes = listRoutes(o.index);
  if (!routes.length) {
    el.replaceChildren(
      h(
        "div",
        { class: "cost-empty" },
        h("h2", null, "No endpoints found"),
        h(
          "p",
          null,
          "BuildRAX detects routes for Next.js (app and pages routers), Express, Fastify, Hono, Koa, NestJS, FastAPI and Flask. Rescan after adding one: buildrax scan",
        ),
      ),
    );
    return;
  }
  if (!o.ui.route || !routes.some((r) => r.id === o.ui.route)) o.ui.route = routes[0]!.id;
  const flow = routeFlow(o.index, o.ui.route);
  const r = flow?.route;
  el.replaceChildren(
    h(
      "div",
      { class: "flows-inner" },
      routeList(routes, o),
      h(
        "section",
        { class: "flows-main" },
        r && flow
          ? h(
              "div",
              null,
              h(
                "header",
                { class: "flows-head" },
                h(
                  "span",
                  { class: "method big", style: `background:${methodColor(r.method)}` },
                  r.method,
                ),
                h("h2", null, r.path ?? "(computed path)"),
                h(
                  "span",
                  { class: "muted" },
                  `${r.framework} · ${r.file ?? ""}${r.line ? `:${r.line}` : ""}${r.handler ? ` · ${r.handler}` : ""}`,
                ),
              ),
              h(
                "p",
                { class: "flows-summary" },
                `Reaches ${flow.participants.files.length} file(s)`,
                flow.participants.infra.length
                  ? ` · ${flow.participants.infra.length} infrastructure component(s)`
                  : "",
                flow.participants.external.length
                  ? ` · ${flow.participants.external.length} package(s)`
                  : "",
                flow.truncated ? " · cut short at depth 6" : "",
              ),
              h("div", { class: "flow-scroll" }, diagram(o.index, flow, o)),
              h("h3", null, "Steps"),
              flow.steps.length
                ? stepList(o.index, flow)
                : h(
                    "p",
                    { class: "muted" },
                    "The handler's file imports nothing BuildRAX can follow.",
                  ),
              h(
                "p",
                { class: "muted small" },
                "Static and file-level: everything the handler's file can reach through imports, not one runtime path. Click a box to see it in the graph.",
              ),
            )
          : h("p", null, "Select an endpoint."),
      ),
    ),
  );
}
