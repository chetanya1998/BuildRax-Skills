/** Where the viewer gets source code from. The model itself never contains source. */
export interface CodeSource {
  readonly mode: "embedded" | "server" | "none";
  get(path: string): Promise<string | undefined>;
  /**
   * A redacted excerpt of a deploy/config file around an evidence line (compose, Terraform,
   * Kubernetes…). Only lines next to recorded evidence exist; secret-looking values are masked.
   */
  excerpt?(file: string, line: number): Promise<{ start: number; lines: string[] } | undefined>;
}

export class NoSource implements CodeSource {
  readonly mode = "none" as const;
  async get(): Promise<undefined> {
    return undefined;
  }
}

/** Static-file mode: sources were embedded by `buildrax view`. */
export class EmbeddedSource implements CodeSource {
  readonly mode = "embedded" as const;
  constructor(private readonly files: Readonly<Record<string, string>>) {}
  async get(path: string): Promise<string | undefined> {
    return Object.prototype.hasOwnProperty.call(this.files, path) ? this.files[path] : undefined;
  }
}

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Served mode: files are fetched on demand; the server only serves files that are model nodes. */
export class ServerSource implements CodeSource {
  readonly mode = "server" as const;
  private readonly cache = new Map<string, Promise<string | undefined>>();
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike,
  ) {}
  get(path: string): Promise<string | undefined> {
    let hit = this.cache.get(path);
    if (!hit) {
      hit = this.fetchFn(`/api/file?path=${encodeURIComponent(path)}`, {
        headers: { "x-buildrax-token": this.token },
      })
        .then(async (res) => {
          if (!res.ok) return undefined;
          const body = (await res.json()) as { text?: unknown };
          return typeof body.text === "string" ? body.text : undefined;
        })
        .catch(() => undefined);
      this.cache.set(path, hit);
    }
    return hit;
  }
}

export function createCodeSource(
  config: { server?: boolean; token?: string } | undefined,
  embedded: unknown,
  fetchFn: FetchLike,
): CodeSource {
  if (config?.server && typeof config.token === "string")
    return new ServerSource(config.token, fetchFn);
  if (embedded && typeof embedded === "object") {
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(embedded as Record<string, unknown>))
      if (typeof v === "string") files[k] = v;
    return new EmbeddedSource(files);
  }
  return new NoSource();
}
