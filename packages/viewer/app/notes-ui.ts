import type { GraphIndex } from "@buildrax/graph";
import {
  FLAG_COLORS,
  NOTE_TYPES,
  NOTES_SCHEMA_VERSION,
  reconcileNotes,
  validateNotes,
  type Model,
  type Note,
  type NoteTarget,
} from "@buildrax/ir";
import { h, put } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import type { NotesStore } from "./notes-store.js";

function snapshotFor(index: GraphIndex, target: NoteTarget): Note["snapshot"] {
  if (target.type !== "node") return undefined;
  const n = index.node(target.id);
  return n ? { kind: n.kind, name: n.name, path: n.path } : undefined;
}

function noteView(note: Note, store: NotesStore): HTMLElement {
  const body = h("div", { class: "note-body" }, renderMarkdown(note.body));
  const meta = h(
    "div",
    { class: "muted" },
    h(
      "span",
      { class: `badge dot-${note.type === "flag" ? (note.color ?? "red") : note.type}` },
      note.type === "flag" ? `flag · ${note.color ?? "red"}` : note.type,
    ),
    ` ${note.updatedAt.slice(0, 10)}${note.resolved ? " · resolved" : ""}`,
  );
  const resolve = h("button", { type: "button" }, note.resolved ? "Reopen" : "Resolve");
  resolve.addEventListener("click", () => store.update(note.id, { resolved: !note.resolved }));
  const edit = h("button", { type: "button" }, "Edit");
  edit.addEventListener("click", () => {
    const area = h("textarea", { rows: 3, maxlength: 4000 });
    area.value = note.body;
    const save = h("button", { type: "button" }, "Save");
    const cancel = h("button", { type: "button" }, "Cancel");
    save.addEventListener("click", () =>
      store.update(note.id, { body: area.value.trim() || note.body }),
    );
    cancel.addEventListener("click", () => store.update(note.id, {}));
    body.replaceChildren(area, h("div", { class: "actions" }, save, cancel));
  });
  const del = h("button", { type: "button" }, "Delete");
  del.addEventListener("click", () => store.delete(note.id));
  return h(
    "li",
    { class: `note${note.resolved ? " resolved" : ""}` },
    meta,
    body,
    h("div", { class: "actions" }, resolve, edit, del),
  );
}

/** Inspector section: existing notes for a target plus an "add note" form. */
export function renderNotesSection(
  target: NoteTarget,
  store: NotesStore,
  index: GraphIndex,
): HTMLElement {
  const mine = store
    .list()
    .filter((n) => n.target.type === target.type && n.target.id === target.id);
  const type = h(
    "select",
    { "aria-label": "Note type" },
    ...NOTE_TYPES.map((t) => h("option", { value: t }, t)),
  );
  const color = h(
    "select",
    { "aria-label": "Flag color" },
    ...FLAG_COLORS.map((c) => h("option", { value: c }, c)),
  );
  const body = h("textarea", {
    rows: 3,
    maxlength: 4000,
    placeholder: "Reminder, question, decision… (**bold**, *italic*, `code`, - lists)",
    "aria-label": "Note text",
  });
  const add = h("button", { type: "button" }, "Add note");
  const syncColor = (): void => void (color.style.display = type.value === "flag" ? "" : "none");
  type.addEventListener("change", syncColor);
  type.value = "flag";
  syncColor();
  add.addEventListener("click", () => {
    const text = body.value.trim();
    if (!text) return;
    store.create({
      target,
      type: type.value as Note["type"],
      color: type.value === "flag" ? (color.value as Note["color"]) : undefined,
      body: text,
      snapshot: snapshotFor(index, target),
    });
  });
  return h(
    "section",
    { class: "notes-section" },
    h("h3", null, `Your notes (${mine.length})`),
    mine.length
      ? h("ul", { class: "notes" }, ...mine.map((n) => noteView(n, store)))
      : h(
          "p",
          { class: "muted" },
          "None yet. Notes are yours: the architecture itself stays read-only.",
        ),
    h("div", { class: "note-form" }, h("div", { class: "actions" }, type, color), body, add),
  );
}

/** Re-attach notes whose node was renamed/moved, when exactly one node matches the snapshot. */
export function relocateNotes(store: NotesStore, model: Model): void {
  for (const r of reconcileNotes(store.list(), model).relocated) {
    store.update(r.note.id, { target: { type: "node", id: r.to } });
  }
}

export interface NotesPanelCtx {
  store: NotesStore;
  model: Model;
  index: GraphIndex;
  selectedNodeId?: string;
  onJump(note: Note): void;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Left-panel notes: open list, orphan tray, export/import and where notes are stored. */
export function renderNotesPanel(root: HTMLElement, ctx: NotesPanelCtx): void {
  const { store, model } = ctx;
  const all = store.list();
  const rec = reconcileNotes(all, model);
  const open = rec.attached.filter((n) => !n.resolved);
  const nameOf = (n: Note): string =>
    n.target.type === "node"
      ? (ctx.index.node(n.target.id)?.name ?? n.target.id)
      : n.target.id
          .split("=>")
          .map((x) => ctx.index.node(x)?.name ?? x)
          .join(" → ");

  const jump = (n: Note): HTMLElement => {
    const b = h("button", { class: "link", type: "button" }, `${nameOf(n)}`);
    b.addEventListener("click", () => ctx.onJump(n));
    return h(
      "li",
      null,
      b,
      h(
        "span",
        { class: "muted" },
        ` ${n.type}: ${n.body.slice(0, 60)}${n.body.length > 60 ? "…" : ""}`,
      ),
    );
  };

  const exportBtn = h("button", { type: "button" }, "Export");
  exportBtn.addEventListener("click", () =>
    download(
      "notes.json",
      `${JSON.stringify({ schemaVersion: NOTES_SCHEMA_VERSION, notes: store.list() }, null, 2)}\n`,
    ),
  );
  const importInput = h("input", {
    type: "file",
    accept: "application/json,.json",
    style: "display:none",
  });
  const importBtn = h("button", { type: "button" }, "Import");
  importBtn.addEventListener("click", () => importInput.click());
  const status = h("p", { class: "warn" });
  importInput.addEventListener("change", async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const checked = validateNotes(JSON.parse(await f.text()));
      if (checked.ok && checked.file) store.merge(checked.file.notes);
      else status.textContent = `Import failed: ${checked.errors.slice(0, 2).join("; ")}`;
    } catch (err) {
      status.textContent = `Import failed: ${String(err)}`;
    }
  });

  const orphanItems = rec.orphaned.map((n) => {
    const attach = h("button", { type: "button" }, "Attach to selected");
    attach.disabled = !ctx.selectedNodeId;
    attach.addEventListener("click", () => {
      if (ctx.selectedNodeId)
        store.update(n.id, {
          target: { type: "node", id: ctx.selectedNodeId },
          snapshot: snapshotFor(ctx.index, { type: "node", id: ctx.selectedNodeId }),
        });
    });
    const del = h("button", { type: "button" }, "Delete");
    del.addEventListener("click", () => store.delete(n.id));
    return h(
      "li",
      { class: "note" },
      h("div", { class: "muted" }, `was on ${n.snapshot?.name ?? n.target.id}`),
      renderMarkdown(n.body),
      h("div", { class: "actions" }, attach, del),
    );
  });

  root.replaceChildren();
  put(
    root,
    h("h3", null, `Your notes (${open.length} open)`),
    h(
      "p",
      { class: "muted" },
      store.mode === "file"
        ? "Saved to .buildrax/notes.json"
        : "Saved in this browser. Export to keep them in the repo, or run `buildrax serve`.",
    ),
    open.length ? h("ul", null, ...open.map(jump)) : h("p", { class: "muted" }, "no open notes"),
    rec.orphaned.length ? h("h3", null, `Orphaned notes (${rec.orphaned.length})`) : null,
    rec.orphaned.length
      ? h(
          "p",
          { class: "muted" },
          "Their code disappeared in the last scan. Select a node to re-attach, or delete.",
        )
      : null,
    rec.orphaned.length ? h("ul", { class: "notes" }, ...orphanItems) : null,
    h("div", { class: "actions" }, exportBtn, importBtn, importInput),
    status,
  );
}
