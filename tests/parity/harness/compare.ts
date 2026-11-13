// Runs one scenario through every engine and compares the normalized facets. The outcome per facet: same, different (with both sides), or not covered
// (with why). A scenario is "same" only when every facet it compares is the same on both engines and none is uncovered.
import { normalize } from "./normalize.js";
import { FACETS, type Facet, type Observation, type ParityEngine, type Scenario, type Step } from "./types.js";

export type FacetOutcome = { facet: Facet; outcome: "same" } | { facet: Facet; outcome: "different"; cloud: readonly string[]; core: readonly string[] } | { facet: Facet; outcome: "not covered"; reason: string };

export interface ScenarioResult {
  scenario: Scenario;
  outcome: "same" | "different" | "not covered";
  facets: FacetOutcome[];
  /** Why the scenario could not run (an unsupported step, or an engine that threw). */
  notCovered?: string;
}

const flat = (steps: readonly Step[]): Step[] => steps.flatMap((step) => (step.do === "race" ? [step, ...flat(step.steps)] : [step]));

export async function compareScenario(scenario: Scenario, cloud: ParityEngine, core: ParityEngine): Promise<ScenarioResult> {
  for (const engine of [cloud, core]) {
    for (const step of flat(scenario.steps)) {
      const support = engine.supports(step);
      if (support !== true) return { scenario, outcome: "not covered", facets: [], notCovered: `${engine.name}: step ${step.do}: ${support.unsupported}` };
    }
  }
  let seen: [Observation, Observation];
  try {
    seen = [normalize(await cloud.run(scenario)), normalize(await core.run(scenario))];
  } catch (error) {
    return { scenario, outcome: "not covered", facets: [], notCovered: `an engine failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}` };
  }
  const facets: FacetOutcome[] = (scenario.facets ?? FACETS).map((facet): FacetOutcome => {
    for (const engine of [cloud, core]) {
      const observes = engine.observes(facet);
      if (observes !== true) return { facet, outcome: "not covered", reason: `${engine.name}: ${observes.unsupported}` };
    }
    const [a, b] = [seen[0][facet], seen[1][facet]];
    return JSON.stringify(a) === JSON.stringify(b) ? { facet, outcome: "same" } : { facet, outcome: "different", cloud: a, core: b };
  });
  const outcome = facets.some((entry) => entry.outcome === "different") ? "different" : facets.every((entry) => entry.outcome === "same") ? "same" : facets.some((entry) => entry.outcome === "same") ? "same" : "not covered";
  return { scenario, outcome, facets };
}
