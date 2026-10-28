import { filterEligible } from "../eligibility/filter";
import {
  assessConfidence,
  buildProductEvidence,
  type ConfidenceAssessment,
  type EvidenceStatus,
} from "../evidence/quality";
import { dedupeProducts } from "../products/dedup";
import { scoreProducts } from "../recommend/score";
import { decideRecommendation } from "../recommend/policy";
import type { Verdict } from "../recommend/verdict";
import { SCENARIOS, type Scenario } from "./scenarios";

export interface ScenarioOutcome {
  id: string;
  title: string;
  verdict: Verdict;
  source: "llm" | "rules";
  excluded: number;
  confidence: ConfidenceAssessment;
  uncertainties: string[];
  ratingStatus?: EvidenceStatus;
  pass: boolean;
  failures: string[];
}

export function runScenario(scenario: Scenario): ScenarioOutcome {
  const failures: string[] = [];
  const deduped = dedupeProducts(scenario.products);
  const { eligible, excluded, checks } = filterEligible(
    deduped.products,
    scenario.requirements,
    scenario.intent,
    { allowOverBudget: scenario.allowOverBudget },
  );
  void checks;
  const ranked = scoreProducts(eligible, scenario.intent, scenario.requirements);
  const evidence = new Map(
    ranked.map((entry) => [
      entry.product.id,
      buildProductEvidence(entry.product, deduped.conflicts),
    ]),
  );
  const confidence = assessConfidence(
    ranked.slice(0, 5).map((entry) => entry.product),
    evidence,
  );
  const recommendation = decideRecommendation({
    ranked,
    totalFound: deduped.products.length,
    excluded,
    intent: scenario.intent,
    confidence,
    llmVerdict: scenario.llmVerdict,
  });
  const ratingStatus = ranked[0]
    ? evidence.get(ranked[0].product.id)?.rating.status
    : undefined;

  if (recommendation.verdict !== scenario.expectVerdict) {
    failures.push(
      `expected ${scenario.expectVerdict}, got ${recommendation.verdict}`,
    );
  }
  if (
    scenario.expectExcluded != null &&
    excluded.length !== scenario.expectExcluded
  ) {
    failures.push(
      `expected ${scenario.expectExcluded} excluded, got ${excluded.length}`,
    );
  }
  if (
    scenario.expectEvidenceRating != null &&
    ratingStatus !== scenario.expectEvidenceRating
  ) {
    failures.push(
      `expected rating evidence ${scenario.expectEvidenceRating}, got ${ratingStatus ?? "none"}`,
    );
  }
  if (
    scenario.expectSource != null &&
    recommendation.source !== scenario.expectSource
  ) {
    failures.push(
      `expected source ${scenario.expectSource}, got ${recommendation.source}`,
    );
  }
  if (
    scenario.expectUncertaintyContains != null &&
    !recommendation.uncertainties.some((u) =>
      u.includes(scenario.expectUncertaintyContains as string),
    )
  ) {
    failures.push(
      `missing uncertainty containing "${scenario.expectUncertaintyContains}"`,
    );
  }
  return {
    id: scenario.id,
    title: scenario.title,
    verdict: recommendation.verdict,
    source: recommendation.source,
    excluded: excluded.length,
    confidence,
    uncertainties: recommendation.uncertainties,
    ratingStatus,
    pass: failures.length === 0,
    failures,
  };
}

export interface EvalSuiteResult {
  outcomes: ScenarioOutcome[];
  passed: number;
  failed: number;
}

export function runEvalSuite(
  scenarios: Scenario[] = SCENARIOS,
): EvalSuiteResult {
  const outcomes = scenarios.map(runScenario);
  return {
    outcomes,
    passed: outcomes.filter((o) => o.pass).length,
    failed: outcomes.filter((o) => !o.pass).length,
  };
}
