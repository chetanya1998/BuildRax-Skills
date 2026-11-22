import { h } from "./dom.js";
import type { TraceDirection, TraceLink, TraceStep } from "./trace.js";

export interface TraceUi {
  steps: TraceStep[];
  /** 0 = show every step; n = show steps 1..n. */
  step: number;
  direction: TraceDirection;
  playing: boolean;
  nameOf(id: string): string;
  onDirection(d: TraceDirection): void;
  onStep(n: number): void;
  onPlay(): void;
  onPick(link: TraceLink, step: TraceStep): void;
}

const DIRS: [TraceDirection, string][] = [
  ["both", "Both"],
  ["downstream", "Uses"],
  ["upstream", "Used by"],
];

/**
 * "Trace" section of the Inspector: the selection explained step by step. Each step is one hop
 * away from the previous one, with the file:line that creates the link.
 */
export function renderTraceSection(t: TraceUi): HTMLElement {
  const max = t.steps.reduce((m, s) => Math.max(m, s.n), 0);
  const dirSeg = h(
    "div",
    { class: "trace-dir", role: "radiogroup", "aria-label": "Trace direction" },
    ...DIRS.map(([d, label]) => {
      const b = h(
        "button",
        { type: "button", role: "radio", "aria-checked": String(t.direction === d) },
        label,
      );
      b.addEventListener("click", () => t.onDirection(d));
      return b;
    }),
  );
  const prev = h(
    "button",
    { type: "button", class: "trace-nav", "aria-label": "Previous step" },
    "◀",
  );
  const next = h("button", { type: "button", class: "trace-nav", "aria-label": "Next step" }, "▶");
  const play = h("button", { type: "button", class: "trace-play" }, t.playing ? "Pause" : "Play");
  const label = h(
    "span",
    { class: "trace-pos" },
    max === 0
      ? "no steps"
      : t.step === 0
        ? `all ${max} step${max === 1 ? "" : "s"}`
        : `step ${t.step} of ${max}`,
  );
  prev.disabled = max === 0 || t.step === 1;
  next.disabled = max === 0 || t.step === max;
  prev.addEventListener("click", () => t.onStep(t.step <= 1 ? max : t.step - 1));
  next.addEventListener("click", () => t.onStep(t.step === 0 ? 1 : Math.min(max, t.step + 1)));
  play.disabled = max === 0;
  play.addEventListener("click", () => t.onPlay());
  const showAll = h("button", { type: "button", class: "link" }, "show all");
  showAll.addEventListener("click", () => t.onStep(0));

  const list = h("ol", { class: "trace-steps" });
  for (const s of t.steps) {
    const future = t.step > 0 && s.n > t.step;
    const li = h(
      "li",
      {
        class: `trace-step ${s.direction}${future ? " future" : ""}${t.step === s.n ? " current" : ""}`,
      },
      h(
        "div",
        { class: "trace-head" },
        h("span", { class: "trace-num" }, String(s.n)),
        s.direction === "downstream" ? `uses (${s.links.length})` : `used by (${s.links.length})`,
      ),
    );
    const ul = h("ul", null);
    for (const l of s.links.slice(0, 8)) {
      const b = h(
        "button",
        { type: "button", class: "trace-link", title: "Show this step" },
        h("span", null, t.nameOf(l.from)),
        h("span", { class: "trace-arrow" }, " → "),
        h("span", null, t.nameOf(l.to)),
        l.evidence?.file
          ? h("code", null, `${l.evidence.file}:${l.evidence.startLine ?? "?"}`)
          : null,
      );
      b.addEventListener("click", () => t.onPick(l, s));
      ul.append(h("li", null, b));
    }
    if (s.links.length > 8)
      ul.append(h("li", { class: "muted" }, `+${s.links.length - 8} more on the graph`));
    li.append(ul);
    list.append(li);
  }
  return h(
    "section",
    { class: "trace" },
    h("h3", null, "Trace"),
    h(
      "p",
      { class: "muted" },
      "How this node connects, one hop at a time. Numbers match the badges on the arrows in the Nodes view.",
    ),
    dirSeg,
    h("div", { class: "trace-controls" }, prev, label, next, play, t.step ? showAll : null),
    t.steps.length
      ? list
      : h("p", { class: "muted" }, "Nothing connects to this node in this direction."),
  );
}
