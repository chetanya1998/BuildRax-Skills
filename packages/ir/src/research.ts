import { z } from "zod";

export const RESEARCH_SCHEMA_VERSION = "buildrax-research/v1" as const;

/**
 * registry-metadata  facts reported by a package registry (e.g. latest version, deprecation)
 * docs-link          a documentation/homepage link declared by the maintainers
 * advisory           a security advisory (needs a known version to be meaningful)
 */
export const EVIDENCE_TYPES = ["registry-metadata", "docs-link", "advisory"] as const;
export const RELIABILITY = ["high", "medium", "low"] as const;

export const FindingSchema = z.object({
  id: z.string().min(1),
  /** Architecture node this finding is attached to. */
  nodeId: z.string().min(1),
  /** Technology (package) the finding is about. */
  subject: z.string().min(1),
  finding: z.string().min(1),
  sourceUrl: z.string().url(),
  publisher: z.string().min(1),
  retrievedAt: z.string(),
  evidenceType: z.enum(EVIDENCE_TYPES),
  reliability: z.enum(RELIABILITY),
  /** Why the reliability level was chosen. */
  reliabilityNote: z.string().optional(),
  /** Version or region the finding applies to, when known. */
  applicableVersion: z.string().optional(),
  recommendedAction: z.string().optional(),
});

export const ResearchFileSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION),
  generatedAt: z.string(),
  findings: z.array(FindingSchema),
  /** Lookups that failed, so absence of a finding is never mistaken for "nothing found". */
  errors: z.array(z.object({ subject: z.string(), provider: z.string(), message: z.string() })),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ResearchFile = z.infer<typeof ResearchFileSchema>;

export function validateResearch(input: unknown): {
  ok: boolean;
  errors: string[];
  file?: ResearchFile;
} {
  const parsed = ResearchFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, errors: [], file: parsed.data };
}
