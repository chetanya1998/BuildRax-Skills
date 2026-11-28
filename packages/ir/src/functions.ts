import { z } from "zod";

export const FUNCTIONS_SCHEMA_VERSION = "buildrax-functions/v1" as const;

/**
 * How a call's target was found:
 * local     a function declared in the same file
 * import    a function in the repo file the callee's name is imported from
 * file      a repo file the callee's root name is imported from (the function itself not matched)
 * workspace a function exported by a workspace package the name is imported from
 * external  a package the callee's root name is imported from
 */
export const CALL_VIA = ["local", "import", "file", "workspace", "external"] as const;

export const FnCallSchema = z.object({
  /** Callee as written, shortened (`saveOrder`, `db.query`, `this.repo.find`). */
  name: z.string().min(1),
  /** First call site. */
  line: z.number().int().positive(),
  /** Call sites in this function when more than one. */
  count: z.number().int().positive().optional(),
  /** Function id (`fn:…`) or model node id (`file:…`, `external:…`) when resolved. */
  to: z.string().optional(),
  via: z.enum(CALL_VIA).optional(),
});

export const FnOpSchema = z.object({
  /** reads / writes / publishes / consumes, from the proven data-operation edges. */
  kind: z.string(),
  /** Model node id of the database, cache or queue. */
  to: z.string(),
  line: z.number().int().positive(),
  detail: z.string().optional(),
});

export const FnSchema = z.object({
  /** `fn:<file>#<name>` (with `@<line>` when a file declares the name twice). Stable across scans. */
  id: z.string().min(1),
  /** `name`, `Class.method`, `outer.inner`, or `router.get("/x")` for an inline callback. */
  name: z.string().min(1),
  kind: z.enum(["function", "method", "arrow", "callback"]),
  line: z.number().int().positive(),
  endLine: z.number().int().positive(),
  exported: z.boolean().optional(),
  async: z.boolean().optional(),
  /** Route node ids this function handles. */
  routes: z.array(z.string()).optional(),
  calls: z.array(FnCallSchema),
  ops: z.array(FnOpSchema),
  /** Function ids that call this one (resolved calls only). */
  calledBy: z.array(z.string()).optional(),
  /** Calls not resolved to the repo or a package (built-ins, locals, parameters). */
  otherCalls: z.number().int().nonnegative().optional(),
});

export const FunctionsFileSchema = z.object({
  schemaVersion: z.literal(FUNCTIONS_SCHEMA_VERSION),
  repo: z.string(),
  scannedAt: z.string(),
  stats: z.object({
    files: z.number().int().nonnegative(),
    functions: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  }),
  files: z.array(z.object({ path: z.string(), functions: z.array(FnSchema) })),
});

export type FnCall = z.infer<typeof FnCallSchema>;
export type FnOp = z.infer<typeof FnOpSchema>;
export type FnEntry = z.infer<typeof FnSchema>;
export type FunctionsFile = z.infer<typeof FunctionsFileSchema>;

export function validateFunctions(input: unknown): {
  ok: boolean;
  errors: string[];
  file?: FunctionsFile;
} {
  const parsed = FunctionsFileSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  return { ok: true, errors: [], file: parsed.data };
}
