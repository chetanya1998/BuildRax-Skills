import { promises as fs } from "node:fs";
import path from "node:path";
import {
  emptyNotes,
  validateModel,
  validateNotes,
  validateResearch,
  type Model,
  type NotesFile,
  type ResearchFile,
} from "@buildrax/ir";

export const buildraxDir = (repo: string): string => path.join(path.resolve(repo), ".buildrax");
export const modelPathFor = (repo: string): string => path.join(buildraxDir(repo), "model.json");
export const notesPathFor = (repo: string): string => path.join(buildraxDir(repo), "notes.json");
export const researchPathFor = (repo: string): string =>
  path.join(buildraxDir(repo), "research.json");

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file} is not valid JSON: ${String(err)}`, { cause: err });
  }
}

export async function loadModel(repo: string): Promise<Model> {
  const raw = await readJson(modelPathFor(repo));
  if (raw === undefined) {
    throw new Error(
      `no model found at ${modelPathFor(repo)}. Run \`buildrax scan ${repo}\` first.`,
    );
  }
  const checked = validateModel(raw);
  if (!checked.ok || !checked.model)
    throw new Error(`model.json is invalid:\n${checked.errors.slice(0, 5).join("\n")}`);
  return checked.model;
}

/** Missing file means no notes yet; an invalid file is an error (never silently overwritten). */
export async function loadNotes(repo: string): Promise<NotesFile> {
  const raw = await readJson(notesPathFor(repo));
  if (raw === undefined) return emptyNotes();
  const checked = validateNotes(raw);
  if (!checked.ok || !checked.file)
    throw new Error(`notes.json is invalid:\n${checked.errors.slice(0, 5).join("\n")}`);
  return checked.file;
}

export async function saveNotes(repo: string, notes: NotesFile): Promise<void> {
  await fs.mkdir(buildraxDir(repo), { recursive: true });
  const file = notesPathFor(repo);
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(notes, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}

export async function loadResearch(repo: string): Promise<ResearchFile | undefined> {
  const raw = await readJson(researchPathFor(repo));
  if (raw === undefined) return undefined;
  const checked = validateResearch(raw);
  if (!checked.ok || !checked.file)
    throw new Error(`research.json is invalid:\n${checked.errors.slice(0, 5).join("\n")}`);
  return checked.file;
}
