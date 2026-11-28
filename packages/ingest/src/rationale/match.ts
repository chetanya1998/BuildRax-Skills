import type { Model, RationaleLink } from "@buildrax/ir";

/**
 * Package names that are distinctive enough to match as plain words in prose ("we use Prisma").
 * Anything else must appear as a path or a `code span`. Keys are lower-case words; values the
 * package name as it appears in the model.
 */
const TECH_WORDS: Record<string, string> = {
  prisma: "prisma",
  "@prisma/client": "@prisma/client",
  drizzle: "drizzle-orm",
  "drizzle-orm": "drizzle-orm",
  express: "express",
  fastify: "fastify",
  hono: "hono",
  koa: "koa",
  nestjs: "@nestjs/core",
  fastapi: "fastapi",
  flask: "flask",
  django: "django",
  sqlalchemy: "sqlalchemy",
  sqlmodel: "sqlmodel",
  typeorm: "typeorm",
  mongoose: "mongoose",
  bullmq: "bullmq",
  celery: "celery",
  kafkajs: "kafkajs",
  stripe: "stripe",
  openai: "openai",
  zod: "zod",
  pydantic: "pydantic",
  "next.js": "next",
  nextjs: "next",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  trpc: "@trpc/server",
  graphql: "graphql",
  supabase: "@supabase/supabase-js",
  firebase: "firebase",
  ioredis: "ioredis",
  axios: "axios",
  vitest: "vitest",
  playwright: "playwright",
  langchain: "langchain",
  "tree-sitter": "web-tree-sitter",
};

/** Tech names that are also English words: only the capitalised form counts ("Express"). */
const AMBIGUOUS = new Set(["express", "react", "flask", "stripe", "next.js"]);

/** Database engines and the words people use for them. */
const ENGINE_WORDS: Record<string, string[]> = {
  postgres: ["postgres", "postgresql", "pg"],
  mysql: ["mysql", "mariadb"],
  mongodb: ["mongodb", "mongo"],
  sqlite: ["sqlite"],
  dynamodb: ["dynamodb"],
};

const VIA_RANK: Record<RationaleLink["via"], number> = {
  path: 0,
  code: 1,
  name: 2,
  location: 3,
  changed: 4,
  project: 5,
};
const MAX_LINKS = 20;

export interface Matcher {
  /** Links for a piece of markdown or plain text (fenced code blocks are ignored). */
  match(text: string): RationaleLink[];
}

const push = (m: Map<string, Set<string>>, k: string, id: string): void => {
  if (!k) return;
  const s = m.get(k) ?? new Set<string>();
  s.add(id);
  m.set(k, s);
};

/** Index the model's names once; matching is exact, never fuzzy. */
export function buildMatcher(model: Model): Matcher {
  const code = new Map<string, Set<string>>(); // exact text inside `…`
  const paths = new Map<string, Set<string>>(); // path-like tokens in prose
  const words = new Map<string, Set<string>>(); // lower-case distinctive words
  const baseCount = new Map<string, number>();
  for (const n of model.nodes)
    if (n.kind === "file" && n.path) {
      const b = n.path.split("/").pop()!;
      baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
    }
  const externals = new Map<string, string>();
  for (const n of model.nodes) {
    switch (n.kind) {
      case "file":
        if (!n.path) break;
        push(code, n.path, n.id);
        if (n.path.includes("/")) push(paths, n.path, n.id);
        if (baseCount.get(n.path.split("/").pop()!) === 1)
          push(code, n.path.split("/").pop()!, n.id);
        break;
      case "module":
        if (n.path && n.path !== ".") {
          push(code, n.path, n.id);
          push(code, `${n.path}/`, n.id);
          if (n.path.includes("/")) {
            push(paths, n.path, n.id);
            push(paths, `${n.path}/`, n.id);
          }
        }
        if (n.meta?.["package"]) {
          push(code, n.name, n.id);
          if (/[@/]/.test(n.name)) push(paths, n.name, n.id);
        }
        break;
      case "external":
        push(code, n.name, n.id);
        externals.set(n.name, n.id);
        if (/^@[\w.-]+\/[\w.-]+$/.test(n.name)) push(paths, n.name, n.id);
        break;
      case "entity":
        push(code, n.name, n.id);
        if (typeof n.meta?.["table"] === "string") push(code, n.meta["table"], n.id);
        break;
      case "route": {
        const p = n.meta?.["path"];
        if (typeof p === "string" && p.length > 1) {
          push(paths, p, n.id);
          push(code, p, n.id);
          push(code, n.name, n.id);
        }
        break;
      }
      default:
        if (n.meta?.["infra"]) {
          const base = n.name.replace(/\s*\(.*\)$/, "").trim();
          push(code, n.name, n.id);
          // Compute and hosting are named after the project's own services ("api", "web"):
          // too generic for prose, so only an exact `code span` links them.
          if (n.kind === "compute" || n.kind === "hosting") break;
          if (base.length >= 3) push(words, base.toLowerCase(), n.id);
          const key = n.id.slice(n.id.indexOf(":") + 1);
          if (key.length >= 4 && /^[a-z0-9-]+$/.test(key)) push(words, key, n.id);
          if (n.kind === "database")
            for (const w of ENGINE_WORDS[String(n.meta["engine"] ?? "")] ?? [])
              push(words, w, n.id);
        }
    }
  }
  for (const [word, pkg] of Object.entries(TECH_WORDS)) {
    const id = externals.get(pkg);
    if (id) push(words, word, id);
  }

  return {
    match(text: string): RationaleLink[] {
      const found = new Map<string, RationaleLink["via"]>();
      const add = (ids: Set<string> | undefined, via: RationaleLink["via"]): void => {
        for (const id of ids ?? []) {
          const prev = found.get(id);
          if (!prev || VIA_RANK[via] < VIA_RANK[prev]) found.set(id, via);
        }
      };
      const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, " ");
      for (const m of prose.matchAll(/`([^`\n]{1,200})`/g)) {
        const span = m[1]!.trim().replace(/^\.\//, "");
        add(code.get(span), "code");
        // `GET /api/orders` / `db.ts:12` / `src/lib/db.ts#L4`
        add(code.get(span.replace(/[:#]L?\d+(-\d+)?$/, "")), "code");
      }
      const plain = prose.replace(/`[^`\n]*`/g, " ");
      for (const m of plain.matchAll(/[\w@./:-]+/g)) {
        const tok = m[0].replace(/^\.\//, "").replace(/[.,:;)]+$/, "");
        if (tok.includes("/")) add(paths.get(tok), tok.startsWith("/") ? "name" : "path");
        const lower = tok.toLowerCase();
        if (AMBIGUOUS.has(lower) && tok[0] !== tok[0]!.toUpperCase()) continue;
        add(words.get(lower), "name");
      }
      return [...found.entries()]
        .map(([node, via]) => ({ node, via }))
        .sort((a, b) => VIA_RANK[a.via] - VIA_RANK[b.via] || (a.node < b.node ? -1 : 1))
        .slice(0, MAX_LINKS);
    },
  };
}
