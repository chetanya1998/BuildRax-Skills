import { h, s } from "./dom.js";
import {
  clampFloat,
  parsePanelPrefs,
  toggled,
  type FloatRect,
  type PanelMode,
  type PanelPrefs,
  type Side,
} from "./panel-prefs.js";

const STORAGE_KEY = "buildrax:panels";

const ICONS: Record<string, string> = {
  left: "M10 3 L5 8 L10 13",
  right: "M6 3 L11 8 L6 13",
  float: "M3 6 H10 V13 H3 Z M8 3 H13 V8 M13 3 L7.5 8.5",
  dock: "M2.5 3.5 H13.5 V12.5 H2.5 Z M10 3.5 V12.5",
  close: "M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5",
  map: "M2 4 L6 2.5 L10 4 L14 2.5 V12 L10 13.5 L6 12 L2 13.5 Z M6 2.5 V12 M10 4 V13.5",
  min: "M4 8 H12",
  plus: "M4 8 H12 M8 4 V12",
};

/** Small icon button; the label is used for both the tooltip and screen readers. */
export function iconButton(icon: string, label: string, cls = "icon-btn"): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: cls, title: label, "aria-label": label },
    s(
      "svg",
      { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
      s("path", { d: ICONS[icon] ?? "" }),
    ),
  );
}

export interface PanelElements {
  body: HTMLElement;
  canvas: HTMLElement;
  left: HTMLElement;
  right: HTMLElement;
  /** Where each side's buttons go (inside its header). */
  leftActions: HTMLElement;
  rightActions: HTMLElement;
  /** Elements that start a drag of a floating window. */
  leftHandle: HTMLElement;
  rightHandle: HTMLElement;
  minimapWrap: HTMLElement;
  legend: HTMLElement;
}

/**
 * Collapsible, detachable sidebars plus minimap and legend visibility. Preferences are stored in
 * this browser only (wrapped in try/catch, so blocked storage just means they are not remembered).
 */
export class Panels {
  readonly prefs: PanelPrefs;
  private readonly lastVisible: Record<Side, Exclude<PanelMode, "collapsed">>;
  private readonly floatBtn: Record<Side, HTMLButtonElement>;
  private readonly collapseBtn: Record<Side, HTMLButtonElement>;
  private readonly edgeTab: Record<Side, HTMLButtonElement>;
  private readonly mapToggle = iconButton("map", "Show or hide the minimap (M)", "map-toggle");

  constructor(
    private readonly el: PanelElements,
    private readonly onLayoutChange: () => void,
  ) {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage blocked */
    }
    this.prefs = parsePanelPrefs(saved);
    this.lastVisible = {
      left: this.prefs.left === "floating" ? "floating" : "docked",
      right: this.prefs.right === "floating" ? "floating" : "docked",
    };

    const make = (side: Side, label: string): void => {
      const float = iconButton("float", `Detach ${label} into a floating window`);
      const collapse = iconButton(side, `Hide ${label} (${side === "left" ? "[" : "]"})`);
      float.addEventListener("click", () =>
        this.setMode(side, this.prefs[side] === "floating" ? "docked" : "floating"),
      );
      collapse.addEventListener("click", () => this.setMode(side, "collapsed"));
      (side === "left" ? el.leftActions : el.rightActions).append(float, collapse);
      // Visible grip so a floating window can always be dragged, even when its header is all tabs.
      const grip = h(
        "span",
        { class: "drag-grip", title: "Drag to move", "aria-hidden": "true" },
        s(
          "svg",
          { viewBox: "0 0 10 16", width: 8, height: 14 },
          ...[3, 8, 13].flatMap((y) => [
            s("circle", { cx: 2.5, cy: y, r: 1.3 }),
            s("circle", { cx: 7.5, cy: y, r: 1.3 }),
          ]),
        ),
      );
      (side === "left" ? el.leftHandle : el.rightHandle).prepend(grip);
      const tab = h(
        "button",
        {
          type: "button",
          class: `edge-tab ${side}`,
          title: `Show ${label} (${side === "left" ? "[" : "]"})`,
          "aria-label": `Show ${label}`,
        },
        s(
          "svg",
          { viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": "true" },
          s("path", { d: ICONS[side === "left" ? "right" : "left"]! }),
        ),
        h("span", null, label),
      );
      tab.addEventListener("click", () => this.setMode(side, this.lastVisible[side]));
      el.canvas.append(tab);
      this.floatBtn[side] = float;
      this.collapseBtn[side] = collapse;
      this.edgeTab[side] = tab;
      this.enableDrag(side, side === "left" ? el.leftHandle : el.rightHandle);
    };
    this.floatBtn = {} as Record<Side, HTMLButtonElement>;
    this.collapseBtn = {} as Record<Side, HTMLButtonElement>;
    this.edgeTab = {} as Record<Side, HTMLButtonElement>;
    make("left", "Overview");
    make("right", "Inspector");

    const close = iconButton("close", "Hide the minimap (M)", "minimap-close");
    close.addEventListener("click", () => this.setMinimap(false));
    el.minimapWrap.append(close);
    this.mapToggle.addEventListener("click", () => this.setMinimap(!this.prefs.minimap));

    // Remember floating sizes after the user resizes a window.
    const ro = new ResizeObserver(() => this.captureFloatSizes());
    ro.observe(el.left);
    ro.observe(el.right);
    window.addEventListener("resize", () => this.apply(false));
    this.apply(false);
  }

  /** Button for the zoom stack that brings the minimap back. */
  get minimapToggle(): HTMLButtonElement {
    return this.mapToggle;
  }

  setMode(side: Side, mode: PanelMode): void {
    if (mode !== "collapsed") this.lastVisible[side] = mode;
    this.prefs[side] = mode;
    this.apply(true);
  }

  toggle(side: Side): void {
    this.setMode(side, toggled(this.prefs[side], this.lastVisible[side]));
  }

  setMinimap(on: boolean): void {
    this.prefs.minimap = on;
    this.apply(false);
  }

  setLegend(open: boolean): void {
    this.prefs.legend = open;
    this.apply(false);
  }

  private apply(layoutChanged: boolean): void {
    const { body } = this.el;
    const bounds = { w: body.clientWidth, h: body.clientHeight };
    for (const side of ["left", "right"] as const) {
      const panel = side === "left" ? this.el.left : this.el.right;
      const mode = this.prefs[side];
      panel.classList.toggle("docked", mode === "docked");
      panel.classList.toggle("collapsed", mode === "collapsed");
      panel.classList.toggle("floating", mode === "floating");
      document.body.classList.toggle(`${side}-off`, mode !== "docked");
      this.edgeTab[side].hidden = mode !== "collapsed";
      const floating = mode === "floating";
      const f = this.floatBtn[side];
      f.title = floating ? "Dock back into the sidebar" : `Detach into a floating window`;
      f.setAttribute("aria-label", f.title);
      f.querySelector("path")!.setAttribute("d", floating ? ICONS.dock! : ICONS.float!);
      if (floating && bounds.w > 0) {
        const key = side === "left" ? "leftFloat" : "rightFloat";
        const r = clampFloat(this.prefs[key], bounds, side);
        this.prefs[key] = r;
        Object.assign(panel.style, {
          left: `${r.x}px`,
          top: `${r.y}px`,
          width: `${r.w}px`,
          height: `${r.h}px`,
        });
      } else {
        for (const p of ["left", "top", "width", "height"] as const) panel.style[p] = "";
      }
    }
    document.body.classList.toggle("map-off", !this.prefs.minimap);
    document.body.classList.toggle("legend-min", !this.prefs.legend);
    this.mapToggle.setAttribute("aria-pressed", String(this.prefs.minimap));
    this.save();
    if (layoutChanged) this.onLayoutChange();
  }

  private captureFloatSizes(): void {
    for (const side of ["left", "right"] as const) {
      if (this.prefs[side] !== "floating") continue;
      const panel = side === "left" ? this.el.left : this.el.right;
      const key = side === "left" ? "leftFloat" : "rightFloat";
      const r = this.prefs[key];
      if (Math.abs(panel.offsetWidth - r.w) > 1 || Math.abs(panel.offsetHeight - r.h) > 1) {
        // A resize can push the window past the edge: keep the new size, nudge it back inside.
        const next = clampFloat(
          { ...r, w: panel.offsetWidth, h: panel.offsetHeight },
          { w: this.el.body.clientWidth, h: this.el.body.clientHeight },
          side,
        );
        this.prefs[key] = next;
        panel.style.left = `${next.x}px`;
        panel.style.top = `${next.y}px`;
        this.save();
      }
    }
  }

  /** Drag a floating window by its header (buttons and tabs inside it keep working). */
  private enableDrag(side: Side, handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (ev) => {
      if (this.prefs[side] !== "floating" || ev.button !== 0) return;
      if ((ev.target as Element).closest("button, input, select, textarea, a")) return;
      ev.preventDefault();
      const key = side === "left" ? "leftFloat" : "rightFloat";
      const start = { ...this.prefs[key] };
      const sx = ev.clientX;
      const sy = ev.clientY;
      const panel = side === "left" ? this.el.left : this.el.right;
      panel.classList.add("moving");
      const move = (m: PointerEvent): void => {
        const next: FloatRect = {
          ...start,
          x: start.x + m.clientX - sx,
          y: start.y + m.clientY - sy,
        };
        this.prefs[key] = clampFloat(
          next,
          { w: this.el.body.clientWidth, h: this.el.body.clientHeight },
          side,
        );
        const r = this.prefs[key];
        panel.style.left = `${r.x}px`;
        panel.style.top = `${r.y}px`;
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        panel.classList.remove("moving");
        this.save();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private save(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage blocked: the layout still works for this visit */
    }
  }
}
