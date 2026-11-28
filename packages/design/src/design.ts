import type { FunctionsFile, Model, RationaleFile, ResearchFile } from "@buildrax/ir";
import { buildC4 } from "./c4.js";
import { detectConcepts, type ConceptHit } from "./concepts.js";
import { buildScorecard, type Scorecard } from "./scorecard.js";
import type { C4Model } from "./types.js";

export const DESIGN_VERSION = "buildrax-design/v1" as const;

export interface DesignInput {
  model: Model;
  functions?: FunctionsFile;
  rationale?: RationaleFile;
  research?: ResearchFile;
}

export interface DesignModel {
  version: typeof DESIGN_VERSION;
  repo: string;
  scannedAt: string;
  c4: C4Model;
  concepts: ConceptHit[];
  scorecard: Scorecard;
  /** Inputs that were available; missing ones make parts of the design thinner, never wrong. */
  inputs: { functions: boolean; rationale: boolean; research: boolean };
}

/** The design model: C4 projection, concepts and NFR scorecard. Deterministic, zero tokens. */
export function buildDesign(input: DesignInput): DesignModel {
  const c4 = buildC4(input.model, input.functions);
  const concepts = detectConcepts({
    model: input.model,
    c4,
    functions: input.functions,
    rationale: input.rationale,
  });
  const scorecard = buildScorecard({ model: input.model, c4, concepts, research: input.research });
  return {
    version: DESIGN_VERSION,
    repo: input.model.meta.repo,
    scannedAt: input.model.meta.scannedAt,
    c4,
    concepts,
    scorecard,
    inputs: {
      functions: !!input.functions,
      rationale: !!input.rationale,
      research: !!input.research,
    },
  };
}
