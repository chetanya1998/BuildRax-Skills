import { z } from "zod";

export const REVIEW_SCHEMA_VERSION = "buildrax-design-review/v1" as const;
export const REVIEW_TYPES = ["flaw", "risk", "strength", "rationale", "recommendation"] as const;
export const REVIEW_SEVERITIES = ["high", "medium", "low"] as const;

/** One claim from the user's coding agent about the design. It is AI inference until cited. */
export const ReviewItemSchema = z.object({
  type: z.enum(REVIEW_TYPES),
  title: z.string().min(3).max(120),
  body: z.string().min(1).max(1500),
  severity: z.enum(REVIEW_SEVERITIES).optional(),
  /** Model node ids or design element ids (c4:…) the claim is about. */
  nodes: z.array(z.string().min(1)).min(1).max(12),
  /** Code locations the agent read to support the claim. */
  evidence: z
    .array(z.object({ file: z.string().min(1), line: z.number().int().positive() }))
    .max(8)
    .optional(),
  /** Public sources (HTTPS) with the date they were read. */
  sources: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string().max(200).optional(),
        accessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .max(5)
    .optional(),
  /** Catalogue concept id the claim relates to (see `buildrax design --json`). */
  concept: z.string().optional(),
});

/** What the agent writes and `buildrax design --import` reads. */
export const ReviewInputSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  /** Free-text name of the agent or model, as it reports itself. */
  agent: z.string().max(60).optional(),
  items: z.array(ReviewItemSchema).min(1).max(60),
});

/** What is stored in `.buildrax/design-review.json` after the CLI checked it. */
export const ReviewFileSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  agent: z.string().optional(),
  importedAt: z.string(),
  /** Scan the review was checked against; a newer scan may make it stale. */
  modelScannedAt: z.string(),
  items: z.array(
    ReviewItemSchema.extend({
      id: z.string(),
      /** Always AI inference; `cited` says whether it names a public source. */
      provenance: z.literal("ai"),
      cited: z.boolean(),
    }),
  ),
});

export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export type ReviewFile = z.infer<typeof ReviewFileSchema>;

const issues = (e: z.ZodError): string[] =>
  e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export function validateReviewInput(input: unknown): {
  ok: boolean;
  errors: string[];
  review?: ReviewInput;
} {
  const parsed = ReviewInputSchema.safeParse(input);
  return parsed.success
    ? { ok: true, errors: [], review: parsed.data }
    : { ok: false, errors: issues(parsed.error) };
}

export function validateReviewFile(input: unknown): {
  ok: boolean;
  errors: string[];
  file?: ReviewFile;
} {
  const parsed = ReviewFileSchema.safeParse(input);
  return parsed.success
    ? { ok: true, errors: [], file: parsed.data }
    : { ok: false, errors: issues(parsed.error) };
}
