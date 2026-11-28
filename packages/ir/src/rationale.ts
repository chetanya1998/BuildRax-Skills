import { z } from "zod";

export const RATIONALE_SCHEMA_VERSION = "buildrax-rationale/v1" as const;

/**
 * Where a piece of rationale comes from:
 * adr      an architecture decision record (Documented)
 * doc      a section of a README or docs page that mentions the node (Documented)
 * comment  a code comment that explains a choice (From code)
 * commit   a local git commit message that explains a change (From git history)
 */
export const RATIONALE_KINDS = ["adr", "doc", "comment", "commit"] as const;

/**
 * How a source was tied to a node:
 * path      the text names the file or folder path
 * code      a `code span` names it exactly (file, package, model, table)
 * name      a distinctive name (an infrastructure service, a known framework, a route path)
 * location  the comment sits in that file
 * changed   the commit changed that file (or, for wide commits, files in that package)
 * project   an ADR that names nothing specific applies to the project
 */
export const RATIONALE_VIA = ["path", "code", "name", "location", "changed", "project"] as const;

export const RationaleLinkSchema = z.object({
  node: z.string().min(1),
  via: z.enum(RATIONALE_VIA),
});

export const RationaleSourceSchema = z.object({
  /** adr:<file> · doc:<file>#L<line> · comment:<file>:<line> · commit:<short hash> */
  id: z.string().min(1),
  kind: z.enum(RATIONALE_KINDS),
  title: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** ADR status as written (accepted, superseded, proposed…). */
  status: z.string().optional(),
  /** ADR date or commit date (YYYY-MM-DD). */
  date: z.string().optional(),
  /** Short commit hash. */
  hash: z.string().optional(),
  /** Function index id a comment documents or sits in. */
  fn: z.string().optional(),
  /** Plain text, shortened; rendered escaped. */
  excerpt: z.string(),
  links: z.array(RationaleLinkSchema),
});

export const RationaleFileSchema = z.object({
  schemaVersion: z.literal(RATIONALE_SCHEMA_VERSION),
  repo: z.string(),
  scannedAt: z.string(),
  stats: z.object({
    adrs: z.number().int().nonnegative(),
    docs: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    commits: z.number().int().nonnegative(),
  }),
  /** Whether local git history was read, and how many commits were looked at. */
  git: z.object({ read: z.boolean(), commits: z.number().int().nonnegative() }),
  sources: z.array(RationaleSourceSchema),
  /** Node id → source ids, newest commits first, at most a few commits per node. */
  byNode: z.record(z.string(), z.array(z.string())),
});

export type RationaleLink = z.infer<typeof RationaleLinkSchema>;
export type RationaleSource = z.infer<typeof RationaleSourceSchema>;
export type RationaleFile = z.infer<typeof RationaleFileSchema>;

export function validateRationale(input: unknown): {
  ok: boolean;
  errors: string[];
  file?: RationaleFile;
} {
  const parsed = RationaleFileSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  return { ok: true, errors: [], file: parsed.data };
}
