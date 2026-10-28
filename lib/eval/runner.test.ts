import { describe, expect, it } from "vitest";
import { runEvalSuite } from "./runner";
import { SCENARIOS } from "./scenarios";

describe("eval suite", () => {
  it("passes all deterministic scenarios", () => {
    expect(SCENARIOS.length).toBe(14);
    const result = runEvalSuite();
    const failures = result.outcomes
      .filter((o) => !o.pass)
      .map((o) => `${o.id}: ${o.failures.join("; ")}`);
    expect(failures).toEqual([]);
    expect(result.failed).toBe(0);
  });
});
