import { NOTES_SCHEMA_VERSION, validateNotes, type Note, type NotesFile } from "@buildrax/ir";

export type NewNote = Pick<Note, "target" | "type" | "body"> &
  Partial<Pick<Note, "color" | "snapshot">>;
export type NotePatch = Partial<
  Pick<Note, "body" | "type" | "color" | "resolved" | "target" | "snapshot">
>;

export interface NotesStore {
  /** Where notes are saved, shown to the user so nobody assumes they are in the repo. */
  readonly mode: "browser" | "file";
  list(): Note[];
  create(input: NewNote): Note;
  update(id: string, patch: NotePatch): void;
  delete(id: string): void;
  /** Merge imported notes by id (imported wins). */
  merge(notes: Note[]): void;
  subscribe(fn: () => void): () => void;
}

const newId = (): string =>
  `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** In-memory core; subclasses decide how to persist. */
export abstract class BaseStore implements NotesStore {
  abstract readonly mode: "browser" | "file";
  protected notes: Note[] = [];
  private listeners = new Set<() => void>();

  list(): Note[] {
    return [...this.notes];
  }
  create(input: NewNote): Note {
    const now = new Date().toISOString();
    const note: Note = { id: newId(), createdAt: now, updatedAt: now, ...input };
    this.notes.push(note);
    this.changed();
    return note;
  }
  update(id: string, patch: NotePatch): void {
    const i = this.notes.findIndex((n) => n.id === id);
    if (i < 0) return;
    this.notes[i] = { ...this.notes[i]!, ...patch, updatedAt: new Date().toISOString() };
    this.changed();
  }
  delete(id: string): void {
    this.notes = this.notes.filter((n) => n.id !== id);
    this.changed();
  }
  merge(incoming: Note[]): void {
    const byId = new Map(this.notes.map((n) => [n.id, n]));
    for (const n of incoming) byId.set(n.id, n);
    this.notes = [...byId.values()];
    this.changed();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Replace contents without persisting (used after loading). */
  protected load(notes: Note[]): void {
    this.notes = notes;
    this.emit();
  }
  protected abstract persist(notes: Note[]): void;
  private changed(): void {
    this.persist(this.list());
    this.emit();
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Static-file mode: notes live in this browser, seeded from notes embedded at view time. */
export class LocalStorageStore extends BaseStore {
  readonly mode = "browser" as const;

  constructor(
    private readonly key: string,
    seed: Note[],
    private readonly storage: KeyValueStorage | undefined,
  ) {
    super();
    let initial = seed;
    try {
      const raw = storage?.getItem(key);
      if (raw) {
        const checked = validateNotes(JSON.parse(raw));
        if (checked.ok && checked.file) initial = checked.file.notes;
      }
    } catch {
      /* storage blocked or corrupt: fall back to the embedded notes */
    }
    this.notes = initial;
  }

  protected persist(notes: Note[]): void {
    try {
      this.storage?.setItem(
        this.key,
        JSON.stringify({ schemaVersion: NOTES_SCHEMA_VERSION, notes }),
      );
    } catch {
      /* quota or blocked storage: notes stay in memory for this session */
    }
  }
}

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Served mode: notes round-trip to `.buildrax/notes.json` through the local server. */
export class ServerStore extends BaseStore {
  readonly mode = "file" as const;
  lastError: string | undefined;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
    private readonly onError: (message: string) => void = () => {},
  ) {
    super();
  }

  async init(): Promise<void> {
    try {
      const res = await this.fetchFn("/api/notes", { headers: { "x-buildrax-token": this.token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const checked = validateNotes(await res.json());
      if (!checked.ok || !checked.file) throw new Error(checked.errors.join("; "));
      this.load(checked.file.notes);
    } catch (err) {
      this.report(`could not load notes: ${String(err)}`);
    }
  }

  protected persist(notes: Note[]): void {
    const body: NotesFile = { schemaVersion: NOTES_SCHEMA_VERSION, notes };
    void this.fetchFn("/api/notes", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-buildrax-token": this.token },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) this.report(`could not save notes (HTTP ${res.status})`);
      })
      .catch((err: unknown) => this.report(`could not save notes: ${String(err)}`));
  }

  private report(message: string): void {
    this.lastError = message;
    this.onError(message);
  }
}
