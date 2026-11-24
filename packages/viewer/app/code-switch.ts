import { h } from "./dom.js";

export const CODE_TOOLTIP =
  "Code view: when on, clicking a node, an arrow, an endpoint or a trace step opens a floating " +
  "window with the source lines behind it, highlighted. Drag it by its header, resize it from the " +
  "corner, Esc closes. Config files (compose, Terraform, Kubernetes) show only the lines around " +
  "the evidence, with secret-looking values masked. Code is read from this page (or from buildrax " +
  "serve on your machine) and never sent anywhere. Shortcut: K.";

export interface CodeSwitch {
  el: HTMLElement;
  set(on: boolean): void;
}

/** The one Code view switch (top bar), with a tooltip on hover and keyboard focus. */
export function codeSwitch(opts: {
  on: boolean;
  /** When set, the switch is disabled and the tooltip explains why. */
  unavailable?: string;
  onToggle: (on: boolean) => void;
}): CodeSwitch {
  const disabled = !!opts.unavailable;
  const box = h("input", {
    type: "checkbox",
    role: "switch",
    "aria-describedby": "code-view-tip",
    ...(opts.on && !disabled ? { checked: "" } : {}),
    ...(disabled ? { disabled: "" } : {}),
  });
  box.addEventListener("change", () => opts.onToggle(box.checked));
  const el = h(
    "label",
    { class: `code-toggle${disabled ? " disabled" : ""}` },
    box,
    h("span", null, "Code view"),
    h("span", { class: "info", tabindex: 0, "aria-hidden": "true" }, "?"),
    h(
      "span",
      { class: "tip", role: "tooltip", id: "code-view-tip" },
      opts.unavailable ?? CODE_TOOLTIP,
    ),
  );
  return { el, set: (on) => void (box.checked = on && !disabled) };
}
