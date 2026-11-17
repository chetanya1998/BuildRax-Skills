import { z } from "zod";
import type { Model } from "./schema.js";

export const NOTES_SCHEMA_VERSION = "buildrax-notes/v1" as const;
export const NOTE_TYPES = ["note", "flag", "todo", "question", "decision"] as const;
export const FLAG_COLORS = ["red", "amber", "green", "blue"] as const;

/**
 * Notes live beside the model, never inside it. They target a node id, or an edge by the
 * "<fromNodeId>=><toNodeId>" pair shown in the viewer (stable as long as node ids are).
 */
export const NoteTargetSchema = z.object({
  type: z.enum(["node", "edge"]),
  id: z.string().min(1),
});

/** What the target looked like when the note was written; used to re-attach after renames. */
export const NoteSnapshotSchema = z.object({
  kind: z.string(),
  name: z.string(),
  path: z.string().optional(),
});

export const NoteSchema = z.object({
  id: z.string().min(1),
  target: NoteTargetSchema,
  type: z.enum(NOTE_TYPES),
  /** Only meaningful for flags. */
  color: z.enum(FLAG_COLORS).optional(),
  /** Plain text with a small markdown subset; rendered escaped, never as HTML. */
  body: z.string().max(4000),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolved: z.boolean().optional(),
  snapshot: NoteSnapshotSchema.optional(),
});

export const NotesFileSchema = z.object({
  schemaVersion: z.literal(NOTES_SCHEMA_VERSION),
  notes: z.array(NoteSchema),
});

export type Note = z.infer<typeof NoteSchema>;
export type NoteTarget = z.infer<typeof NoteTargetSchema>;
export type NoteSnapshot = z.infer<typeof NoteSnapshotSchema>;
export type NotesFile = z.infer<typeof NotesFileSchema>;

export interface NotesValidation {
  ok: boolean;
  errors: string[];
  file?: NotesFile;
}

export function emptyNotes(): NotesFile {
  return { schemaVersion: NOTES_SCHEMA_VERSION, notes: [] };
}

export function validateNotes(input: unknown): NotesValidation {
  const parsed = NotesFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const n of parsed.data.notes) {
    if (seen.has(n.id)) errors.push(`notes: duplicate id "${n.id}"`);
    seen.add(n.id);
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], file: parsed.data };
}

export function targetExists(note: Note, model: Model): boolean {
  if (note.target.type === "node") return model.nodes.some((n) => n.id === note.target.id);
  const [from, to] = note.target.id.split("=>");
  return (
    !!from && !!to && model.nodes.some((n) => n.id === from) && model.nodes.some((n) => n.id === to)
  );
}

export interface Reconciled {
  attached: Note[];
  /** Notes whose target vanished but a unique node with the same kind and path/name exists. */
  relocated: { note: Note; to: string }[];
  orphaned: Note[];
}

/**
 * Compare notes against a (re-)scanned model. Never deletes anything: orphans stay in the file
 * so the user can re-attach or remove them.
 */
export function reconcileNotes(notes: readonly Note[], model: Model): Reconciled {
  const out: Reconciled = { attached: [], relocated: [], orphaned: [] };
  for (const note of notes) {
    if (targetExists(note, model)) {
      out.attached.push(note);
      continue;
    }
    const snap = note.snapshot;
    if (note.target.type === "node" && snap) {
      const byPath = snap.path
        ? model.nodes.filter((n) => n.kind === snap.kind && n.path === snap.path)
        : [];
      const matches = byPath.length
        ? byPath
        : model.nodes.filter((n) => n.kind === snap.kind && n.name === snap.name);
      if (matches.length === 1) {
        out.relocated.push({ note, to: matches[0]!.id });
        continue;
      }
    }
    out.orphaned.push(note);
  }
  return out;
}
