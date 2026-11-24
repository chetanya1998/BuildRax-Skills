import type { Flow, GraphIndex } from "@buildrax/graph";
import type { CodeSection, CodeView } from "./canvas-code.js";
import { excerptRange } from "./code-logic.js";
import type { CodeSource } from "./code-source.js";
import { codeBlock } from "./code-ui.js";
import { h } from "./dom.js";
import { MIN_FLOAT, type FloatRect } from "./panel-prefs.js";

/** What the floating code window shows: a file, with the lines that matter marked. */
export interface CodeTarget {
  title: string;
  file: string;
  /** Line to scroll to first. */
  line?: number;
  /** line → short label at the end of the line. */
  marks: [number, string][];
  /** Node to select when the user asks to see it in the graph. */
  nodeId: string;
}

const short = (index: GraphIndex, id: string): string => {
  const n = index.node(id);
  return n?.kind === "file" ? n.name : `${n?.name ?? id}`;
};

/**
 * The code behind a click in the Flows view. Pure, for tests.
 *  - endpoint: the handler's registration line;
 *  - a step: the line that creates that link (import, SDK use);
 *  - a file box: the whole file, with every outgoing step of the flow marked;
 *  - an infrastructure / package box: the line where the flow first reaches it.
 */
/** One label per line: several links made by the same line (`import pg` → pg and PostgreSQL). */
function mergeMarks(marks: [number, string][]): [number, string][] {
  const by = new Map<number, string[]>();
  for (const [line, label] of marks) by.set(line, [...(by.get(line) ?? []), label]);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([l, labels]) => [l, labels.join(" · ")]);
}

export function codeTargetFor(
  index: GraphIndex,
  flow: Flow,
  pick: { kind: "node"; id: string } | { kind: "step"; n: number },
): CodeTarget | undefined {
  if (pick.kind === "step") {
    const st = flow.steps.find((s) => s.n === pick.n);
    const ev = st?.evidence;
    if (!st || !ev?.file) return undefined;
    return {
      title: `Step ${st.n}: ${short(index, st.from)} ${st.kind} ${short(index, st.to)}`,
      file: ev.file,
      line: ev.startLine,
      marks: ev.startLine ? [[ev.startLine, `${st.kind} ${short(index, st.to)}`]] : [],
      nodeId: st.to,
    };
  }
  const r = flow.route;
  if (pick.id === r.id) {
    if (!r.file) return undefined;
    return {
      title: `${r.method} ${r.path ?? "(computed path)"}`,
      file: r.file,
      line: r.line,
      marks: r.line
        ? [[r.line, `${r.method} ${r.path ?? ""}${r.handler ? ` → ${r.handler}` : ""}`.trim()]]
        : [],
      nodeId: flow.entry,
    };
  }
  const n = index.node(pick.id);
  if (n?.kind === "file" && n.path) {
    const marks: [number, string][] = flow.steps
      .filter((s) => s.from === n.id && s.evidence?.file === n.path && !!s.evidence?.startLine)
      .map((s) => [s.evidence!.startLine!, `${s.n}. ${s.kind} ${short(index, s.to)}`]);
    if (n.id === flow.entry && r.line) marks.unshift([r.line, `${r.method} ${r.path ?? ""}`]);
    const merged = mergeMarks(marks);
    return { title: n.path, file: n.path, line: merged[0]?.[0], marks: merged, nodeId: n.id };
  }
  const st = flow.steps.find((s) => s.to === pick.id && s.evidence?.file);
  if (!st) return undefined;
  const viaStep = codeTargetFor(index, flow, { kind: "step", n: st.n });
  return (
    viaStep && {
      ...viaStep,
      title: `${short(index, pick.id)}: reached in step ${st.n}`,
      nodeId: pick.id,
    }
  );
}

/** A Flows target as a window view (one file, scrolled to its line). */
export function targetView(t: CodeTarget): CodeView {
  return {
    title: t.title,
    nodeId: t.nodeId,
    sections: [
      { kind: "file", file: t.file, marks: t.marks, ...(t.line ? { focus: t.line } : {}) },
    ],
  };
}

const languageOf = (file: string): string =>
  /\.py$/.test(file) ? "python" : /\.(tsx?|mts|cts)$/.test(file) ? "typescript" : "javascript";

const RECT_KEY = "buildrax:flows-code-rect";

function loadRect(): FloatRect {
  try {
    const r = JSON.parse(window.localStorage.getItem(RECT_KEY) ?? "null") as FloatRect | null;
    if (r && [r.x, r.y, r.w, r.h].every((v) => typeof v === "number")) return r;
  } catch {
    /* storage blocked or invalid: defaults */
  }
  return { x: -1, y: 96, w: 520, h: 420 };
}
function saveRect(r: FloatRect): void {
  try {
    window.localStorage.setItem(RECT_KEY, JSON.stringify(r));
  } catch {
    /* not persisted */
  }
}

/** Keep the window on screen: at least its header stays reachable. */
function clampToViewport(r: FloatRect): FloatRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_FLOAT.w, Math.min(r.w, vw - 16));
  const hgt = Math.max(MIN_FLOAT.h, Math.min(r.h, vh - 16));
  const x = r.x < 0 ? vw - w - 24 : Math.max(8, Math.min(r.x, vw - w - 8));
  const y = Math.max(8, Math.min(r.y, vh - 48));
  return { x, y, w, h: hgt };
}

/**
 * Floating, draggable, resizable code window. One per page; reused across re-renders so its
 * position, size and scroll survive. Read-only: shows text, never runs or edits anything.
 */
export class FloatingCode {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly graphBtn: HTMLButtonElement;
  private rect: FloatRect;
  private seq = 0;
  private current?: CodeView;
  onShowInGraph?: (nodeId: string) => void;
  onClose?: () => void;

  constructor(private readonly source: CodeSource) {
    this.rect = loadRect();
    this.title = h("span", { class: "fc-title" });
    this.graphBtn = h(
      "button",
      { type: "button", title: "Leave Flows and select this in the graph" },
      "Show in graph",
    );
    const close = h(
      "button",
      {
        type: "button",
        class: "fc-close",
        "aria-label": "Close code window (Esc)",
        title: "Close (Esc)",
      },
      "×",
    );
    const grip = h(
      "div",
      { class: "fc-head", title: "Drag to move" },
      this.title,
      this.graphBtn,
      close,
    );
    this.body = h("div", { class: "fc-body" });
    this.el = h(
      "div",
      { class: "floating-code", role: "dialog", "aria-label": "Code", hidden: "", tabindex: -1 },
      grip,
      this.body,
    );

    this.graphBtn.addEventListener("click", () => {
      if (this.current?.nodeId) this.onShowInGraph?.(this.current.nodeId);
    });
    close.addEventListener("click", () => this.close());
    this.el.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.close();
      }
    });
    // Drag by the header (not its buttons).
    grip.addEventListener("pointerdown", (ev) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      ev.preventDefault();
      const start = { x: ev.clientX, y: ev.clientY, r: { ...this.rect } };
      grip.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent): void => {
        this.rect = clampToViewport({
          ...start.r,
          x: start.r.x + e.clientX - start.x,
          y: start.r.y + e.clientY - start.y,
        });
        this.place();
      };
      const up = (): void => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        saveRect(this.rect);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    // Resizing uses the native corner handle; remember the size afterwards.
    new ResizeObserver(() => {
      if (this.el.hidden) return;
      const w = this.el.offsetWidth;
      const hgt = this.el.offsetHeight;
      if (w && hgt && (w !== this.rect.w || hgt !== this.rect.h)) {
        this.rect = { ...this.rect, w, h: hgt };
        saveRect(this.rect);
      }
    }).observe(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  private place(): void {
    const r = (this.rect = clampToViewport(this.rect));
    Object.assign(this.el.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.w}px`,
      height: `${r.h}px`,
    });
  }

  /** Flows: one file target. */
  async show(t: CodeTarget): Promise<void> {
    return this.showView(targetView(t));
  }

  /** Any view: whole files, excerpts around lines, or a file list. */
  async showView(v: CodeView): Promise<void> {
    const my = ++this.seq;
    this.current = v;
    this.title.textContent = v.title;
    this.title.title = v.title;
    this.graphBtn.hidden = !v.nodeId;
    this.el.hidden = false;
    this.place();
    const alive = (): boolean => my === this.seq;
    this.body.replaceChildren(
      ...(v.note ? [h("p", { class: "muted fc-note" }, v.note)] : []),
      ...v.sections.map((sec) => this.section(sec, alive)),
      ...(v.sections.length
        ? []
        : [h("p", { class: "muted" }, "Nothing to show for this selection.")]),
    );
  }

  /** Opening a file from a file list (set by the page, which knows the model). */
  onOpenFile?: (path: string) => void;

  private section(sec: CodeSection, alive: () => boolean): HTMLElement {
    if (sec.kind === "files") {
      return h(
        "div",
        { class: "fc-files" },
        ...(sec.label ? [h("div", { class: "fc-label" }, sec.label)] : []),
        ...sec.files.map((f) => {
          const b = h(
            "button",
            { type: "button", class: "fc-file" },
            h("span", null, f.path),
            f.lines !== undefined ? h("span", { class: "muted" }, `${f.lines} lines`) : null,
          );
          b.addEventListener("click", () => this.onOpenFile?.(f.path));
          return b;
        }),
      );
    }
    const box = h(
      "div",
      { class: "fc-section" },
      h("p", { class: "muted" }, `Loading ${sec.file}…`),
    );
    const head =
      sec.kind === "excerpt" && sec.label ? h("div", { class: "fc-label" }, sec.label) : null;
    const load: Promise<string | { start: number; lines: string[] } | undefined> =
      sec.kind === "excerpt" && sec.config ? this.configExcerpt(sec) : this.source.get(sec.file);
    void load.then((text) => {
      if (!alive()) return;
      if (text === undefined) {
        box.replaceChildren(h("p", { class: "muted" }, this.missing(sec)));
        return;
      }
      if (sec.kind === "file") {
        if (typeof text !== "string") return;
        box.replaceChildren(
          codeBlock({
            path: sec.file,
            text,
            language: languageOf(sec.file),
            marks: new Map(sec.marks),
            maxLines: 2000,
          }),
        );
        return;
      }
      if (typeof text !== "string") {
        // Redacted config excerpt: { start, lines }
        const ex = text as { start: number; lines: string[] };
        box.replaceChildren(
          codeBlock({
            path: sec.file,
            text: ex.lines.join("\n"),
            language: "plain",
            marks: new Map([[sec.line - ex.start + 1, sec.mark]]),
            lineOffset: ex.start - 1,
          }),
        );
        return;
      }
      const total = text.split("\n").length;
      box.replaceChildren(
        codeBlock({
          path: sec.file,
          text,
          language: languageOf(sec.file),
          range: excerptRange(total, sec.line, 3),
          marks: new Map([[sec.line, sec.mark]]),
        }),
      );
    });
    return head ? h("div", null, head, box) : box;
  }

  private missing(sec: Exclude<CodeSection, { kind: "files" }>): string {
    const where = `${sec.file}${sec.kind === "excerpt" ? `:${sec.line}` : ""}`;
    if (sec.kind === "excerpt" && sec.config)
      return `${where} (deploy/config file). Its lines are not included in this viewer.`;
    return this.source.mode === "server"
      ? `${where}: the local server could not read this file.`
      : `${where}: this viewer was built without this file's source (--no-source, or too large).`;
  }

  /** Config excerpts come from the source's redacted excerpt store (stage 2); none yet. */
  private async configExcerpt(
    sec: Extract<CodeSection, { kind: "excerpt" }>,
  ): Promise<{ start: number; lines: string[] } | undefined> {
    return this.source.excerpt?.(sec.file, sec.line);
  }

  close(): void {
    this.seq++;
    this.el.hidden = true;
    this.current = undefined;
    this.onClose?.();
  }
}
