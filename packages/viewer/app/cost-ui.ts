import {
  ASSUMPTION_LABELS,
  type Assumptions,
  type CostComponent,
  type CostReport,
  type CostTier,
  DEFAULT_ASSUMPTIONS,
  type PriceBook,
  estimate,
  validatePriceBook,
} from "@buildrax/cost";
import type { Model } from "@buildrax/ir";
import { h, s } from "./dom.js";

/** What `buildrax view` embeds: the report plus the prices it may need to recompute. */
export interface CostData {
  report: CostReport;
  prices: PriceBook;
}

/** Accept only well-formed embedded data; anything else means "no estimate yet". */
export function parseCost(raw: unknown): CostData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { report?: Partial<CostReport>; prices?: unknown };
  const rep = r.report;
  if (!rep || rep.schemaVersion !== "buildrax-cost/v1" || !Array.isArray(rep.tiers))
    return undefined;
  if (rep.mode !== "current" && rep.mode !== "product") return undefined;
  const p = validatePriceBook(r.prices);
  if (!p.ok || !p.book) return undefined;
  return { report: rep as CostReport, prices: p.book };
}

/** Colour per component kind, fixed so the chart and the table agree in both themes. */
const HUE: Record<string, number> = {
  app: 212,
  workers: 190,
  alb: 262,
  database: 100,
  cache: 8,
  storage: 36,
  egress: 300,
  frontend: 170,
  email: 330,
  payments: 140,
  llm: 280,
  sms: 52,
};
export const componentColor = (id: string): string => `hsl(${HUE[id] ?? 215} 62% 56%)`;

export const usd = (n: number): string =>
  n >= 10_000
    ? `$${Math.round(n / 100) / 10}k`.replace(".0k", "k")
    : n >= 1000
      ? `$${Math.round(n).toLocaleString("en-US")}`
      : `$${n.toFixed(n < 10 ? 2 : 0)}`;
export const usersLabel = (n: number): string =>
  n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);

/** Recompute with edited assumptions (pure; same code as the CLI). */
export function recompute(data: CostData, model: Model, edits: Partial<Assumptions>): CostReport {
  if (!Object.keys(edits).length) return data.report;
  return estimate({
    mode: data.report.mode,
    model,
    stack: data.report.stack,
    tiers: data.report.tiers.map((t) => t.users),
    assumptions: { ...data.report.assumptions, ...edits },
    prices: data.prices,
  });
}

/** The CLI command that reproduces the current edits (the viewer never writes files). */
export function cliCommand(report: CostReport, edits: Partial<Assumptions>): string {
  const assume = Object.entries(edits)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const stack = Object.entries(report.stack)
    .filter(([k]) => k !== "provider")
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `buildrax cost --mode ${report.mode} --stack ${stack}${assume ? ` --assume ${assume}` : ""}`;
}

export interface CostViewOptions {
  data: CostData | undefined;
  model: Model;
  /** Selected tier index and edited assumptions live with the caller so they survive re-renders. */
  ui: { tier: number; edits: Partial<Assumptions> };
  onChange: () => void;
  onSelectNode: (id: string) => void;
}

const dollars = (c: CostComponent): string =>
  c.incomplete && c.monthly.expected === 0
    ? "price needed"
    : `${usd(c.monthly.expected)}${c.incomplete ? "+" : ""}`;

function tierCards(report: CostReport, o: CostViewOptions): HTMLElement {
  return h(
    "div",
    { class: "cost-tiers", role: "tablist", "aria-label": "Traffic tiers" },
    ...report.tiers.map((t, i) => {
      const b = h(
        "button",
        {
          type: "button",
          role: "tab",
          class: "cost-tier",
          "aria-selected": String(i === o.ui.tier),
        },
        h("span", { class: "cost-users" }, `${usersLabel(t.users)} users`),
        h(
          "b",
          null,
          usd(t.total.expected),
          t.incomplete
            ? h("span", { class: "cost-plus", title: "Some items have no price yet" }, "+")
            : null,
        ),
        h("span", { class: "cost-range" }, `${usd(t.total.low)} – ${usd(t.total.high)}`),
      );
      b.addEventListener("click", () => {
        o.ui.tier = i;
        o.onChange();
      });
      return b;
    }),
  );
}

/** Stacked bars per tier. Bar height is on a log scale (costs span orders of magnitude). */
function chart(report: CostReport, o: CostViewOptions): SVGSVGElement {
  const W = 640,
    H = 190,
    pad = 34,
    gap = 18;
  const n = report.tiers.length;
  const bw = (W - pad * 2 - gap * (n - 1)) / Math.max(1, n);
  const max = Math.max(...report.tiers.map((t) => t.total.expected), 1);
  const min = Math.max(
    1,
    Math.min(...report.tiers.map((t) => t.total.expected).filter((v) => v > 0), max),
  );
  const lo = Math.log10(min) - 0.3,
    hi = Math.log10(max) + 0.05;
  const heightFor = (v: number) => (v <= 0 ? 0 : ((Math.log10(v) - lo) / (hi - lo)) * (H - 46));
  const svg = s("svg", {
    class: "cost-chart",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": "Monthly cost per tier, stacked by component (log scale)",
  });
  report.tiers.forEach((t, i) => {
    const x = pad + i * (bw + gap);
    const total = heightFor(t.total.expected);
    let y = H - 24;
    const g = s("g", { class: `cost-bar${i === o.ui.tier ? " on" : ""}` });
    for (const c of t.components) {
      if (c.monthly.expected <= 0) continue;
      const hgt = (c.monthly.expected / t.total.expected) * total;
      y -= hgt;
      g.append(
        s(
          "rect",
          { x, y, width: bw, height: Math.max(0.5, hgt), fill: componentColor(c.id) },
          s("title", null, `${c.label}: ${usd(c.monthly.expected)}`),
        ),
      );
    }
    g.append(
      s(
        "text",
        { x: x + bw / 2, y: y - 6, "text-anchor": "middle", class: "cost-bar-total" },
        usd(t.total.expected),
      ),
      s(
        "text",
        { x: x + bw / 2, y: H - 8, "text-anchor": "middle", class: "cost-bar-label" },
        usersLabel(t.users),
      ),
    );
    g.addEventListener("click", () => {
      o.ui.tier = i;
      o.onChange();
    });
    svg.append(g);
  });
  return svg;
}

function breakdown(t: CostTier, o: CostViewOptions): HTMLElement {
  return h(
    "table",
    { class: "cost-table" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, "Component"),
        h("th", null, "Sizing"),
        h("th", { class: "num" }, "Expected"),
        h("th", { class: "num" }, "Range"),
      ),
    ),
    h(
      "tbody",
      null,
      ...t.components.map((c) => {
        const name = c.nodeId
          ? h(
              "button",
              { type: "button", class: "link", title: `Show ${c.nodeId} in the graph` },
              c.label,
            )
          : h("span", null, c.label);
        if (c.nodeId) name.addEventListener("click", () => o.onSelectNode(c.nodeId!));
        return h(
          "tr",
          { class: c.incomplete ? "incomplete" : "" },
          h(
            "td",
            null,
            h("i", { class: "swatch", style: `background:${componentColor(c.id)}` }),
            name,
            h("small", null, c.category.replace("-", " ")),
          ),
          h("td", null, c.sizing, ...c.notes.map((x) => h("small", null, x))),
          h("td", { class: "num" }, dollars(c)),
          h(
            "td",
            { class: "num muted" },
            c.incomplete && c.monthly.expected === 0
              ? ""
              : `${usd(c.monthly.low)} – ${usd(c.monthly.high)}`,
          ),
        );
      }),
    ),
  );
}

function list(title: string, items: (string | Node)[], cls = ""): HTMLElement | null {
  if (!items.length) return null;
  return h(
    "section",
    { class: `cost-list ${cls}` },
    h("h4", null, title),
    h("ul", null, ...items.map((x) => h("li", null, x))),
  );
}

function assumptionsEditor(report: CostReport, o: CostViewOptions): HTMLElement {
  const keys = Object.keys(DEFAULT_ASSUMPTIONS) as (keyof Assumptions)[];
  const rows = keys.map((k) => {
    const input = h("input", {
      type: "number",
      min: 0,
      step: "any",
      value: String(report.assumptions[k]),
      "aria-label": ASSUMPTION_LABELS[k],
    });
    if (k in o.ui.edits) input.classList.add("edited");
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0) {
        input.value = String(report.assumptions[k]);
        return;
      }
      if (v === DEFAULT_ASSUMPTIONS[k]) delete o.ui.edits[k];
      else o.ui.edits[k] = v;
      o.onChange();
    });
    return h("label", { class: "cost-assume" }, h("span", null, ASSUMPTION_LABELS[k]), input);
  });
  const reset = h("button", { type: "button" }, "Reset");
  reset.addEventListener("click", () => {
    o.ui.edits = {};
    o.onChange();
  });
  return h(
    "section",
    { class: "cost-list cost-assumptions" },
    h("h4", null, "Assumptions ", h("small", null, "edit to recompute here; nothing is saved")),
    ...rows,
    h("div", { class: "cost-cmd" }, reset, h("code", null, cliCommand(report, o.ui.edits))),
  );
}

function sourceItem(src: CostReport["sources"][number]): HTMLElement {
  const date = (src.publishedAt ?? src.retrievedAt).slice(0, 10);
  const safe = /^https:\/\//.test(src.sourceUrl);
  return h(
    "span",
    null,
    `${src.label} · ${date} · `,
    safe
      ? h(
          "a",
          { href: src.sourceUrl, target: "_blank", rel: "noopener noreferrer" },
          new URL(src.sourceUrl).host,
        )
      : src.sourceUrl,
  );
}

/** The whole Cost view. Read-only with respect to the repo: edits only change this page. */
export function renderCostView(el: HTMLElement, o: CostViewOptions): void {
  if (!o.data) {
    el.replaceChildren(
      h(
        "div",
        { class: "cost-empty" },
        h("h2", null, "No cost estimate yet"),
        h("p", null, "Run one, then regenerate the viewer:"),
        h(
          "pre",
          null,
          "buildrax cost            # current project\nbuildrax cost --mode product   # as a product (asks a few stack questions)\nbuildrax view",
        ),
        h(
          "p",
          { class: "muted" },
          "Add --online to download AWS list prices first. Nothing about your repository is sent.",
        ),
      ),
    );
    return;
  }
  const report = recompute(o.data, o.model, o.ui.edits);
  o.ui.tier = Math.min(o.ui.tier, report.tiers.length - 1);
  const t = report.tiers[o.ui.tier]!;
  const sens = t.sensitivity.map(
    (x) =>
      `${ASSUMPTION_LABELS[x.assumption]}: +50% → ${x.changePct > 0 ? "+" : ""}${x.changePct}%`,
  );
  const missing = report.missingPrices.map((m) =>
    h(
      "span",
      null,
      `${m.label} `,
      h("code", null, m.key),
      m.lookUp?.startsWith("https://")
        ? h("a", { href: m.lookUp, target: "_blank", rel: "noopener noreferrer" }, " pricing page")
        : null,
    ),
  );
  const pal = [
    ...new Map(report.tiers.flatMap((x) => x.components).map((c) => [c.id, c.label])).entries(),
  ];
  el.replaceChildren(
    h(
      "div",
      { class: "cost-inner" },
      h(
        "header",
        { class: "cost-head" },
        h("h2", null, "Cost estimate"),
        h(
          "span",
          { class: `cost-mode ${report.mode}` },
          report.mode === "product" ? "As a product · hypothesis" : "Current project",
        ),
        h("span", { class: "muted" }, `AWS ${report.region} · USD / month`),
        Object.keys(o.ui.edits).length
          ? h("span", { class: "cost-mode edited" }, "edited assumptions")
          : null,
      ),
      h("p", { class: "cost-disclaimer" }, report.disclaimer),
      tierCards(report, o),
      h(
        "div",
        { class: "cost-chart-wrap" },
        chart(report, o),
        h(
          "div",
          { class: "cost-legend" },
          ...pal.map(([id, label]) =>
            h(
              "span",
              null,
              h("i", { class: "swatch", style: `background:${componentColor(id)}` }),
              label,
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "cost-grid" },
        h(
          "div",
          null,
          h(
            "h3",
            null,
            `${usersLabel(t.users)} users · ~${Math.round(t.dau).toLocaleString("en-US")} daily active · peak ~${t.peakRps.toFixed(1)} req/s`,
          ),
          breakdown(t, o),
          list("What changes from the previous tier", t.changes),
          list("Watch out", t.bottlenecks, "warn"),
          list("Most sensitive to", sens),
        ),
        h(
          "div",
          null,
          assumptionsEditor(report, o),
          list(
            "Stack",
            Object.entries(report.stack)
              .filter(([k]) => k !== "provider")
              .map(([k, v]) => `${k}: ${v}`),
            "compact",
          ),
          list("Prices needed (never invented)", missing, "warn"),
          list(
            "Detected but not priced yet",
            report.notPriced.map((n) => n.label),
          ),
          list("Price sources", report.sources.map(sourceItem), "compact"),
        ),
      ),
    ),
  );
}

/** Inspector section for an infrastructure node that the estimate prices. */
export function renderCostSection(
  data: CostData | undefined,
  model: Model,
  edits: Partial<Assumptions>,
  nodeId: string,
  onOpen: () => void,
): HTMLElement | null {
  if (!data) return null;
  const report = recompute(data, model, edits);
  const rows = report.tiers
    .map((t) => ({ t, c: t.components.find((c) => c.nodeId === nodeId) }))
    .filter((x): x is { t: CostTier; c: CostComponent } => !!x.c);
  if (!rows.length) return null;
  const open = h("button", { type: "button", class: "link" }, "Open the Cost view");
  open.addEventListener("click", onOpen);
  return h(
    "section",
    { class: "cost-section" },
    h("h3", null, "Estimated cost"),
    h("p", { class: "muted" }, `${rows[0]!.c.label}, USD / month (estimate)`),
    h(
      "dl",
      { class: "cost-dl" },
      ...rows.flatMap(({ t, c }) => [
        h("dt", null, `${usersLabel(t.users)} users`),
        h("dd", null, dollars(c), h("small", null, ` ${c.sizing}`)),
      ]),
    ),
    open,
  );
}
