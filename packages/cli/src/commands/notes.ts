import { reconcileNotes, type Note } from "@buildrax/ir";
import { loadModel, loadNotes } from "./data.js";

export interface NotesReport {
  open: Note[];
  resolved: number;
  orphaned: Note[];
}

export async function notesCommand(
  repo: string,
  opts: { all?: boolean } = {},
): Promise<NotesReport> {
  const [model, file] = await Promise.all([loadModel(repo), loadNotes(repo)]);
  const rec = reconcileNotes(file.notes, model);
  const attached = [...rec.attached, ...rec.relocated.map((r) => r.note)];
  return {
    open: attached.filter((n) => opts.all || !n.resolved),
    resolved: attached.filter((n) => n.resolved).length,
    orphaned: rec.orphaned,
  };
}

export function formatNotes(r: NotesReport): string {
  const line = (n: Note): string =>
    `  [${n.type}${n.color ? `:${n.color}` : ""}] ${n.target.id}\n      ${n.body.replace(/\n/g, "\n      ")}`;
  return [
    `${r.open.length} note(s)${r.resolved ? `, ${r.resolved} resolved` : ""}`,
    ...r.open.map(line),
    ...(r.orphaned.length
      ? [`${r.orphaned.length} orphaned (target no longer exists):`, ...r.orphaned.map(line)]
      : []),
  ].join("\n");
}
