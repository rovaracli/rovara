// Owner decision 2026-11-02: a review step nobody has set defaults to the strongest usable model of a different company. The stage candidates are read for a bounded pool of models (at most `STAGE_POOL_MAX`),
// which until now held only the project's approved models (or Rovara's own Claude models) and the models a setting names; another company's model the company can use never reached it. This adds the models
// the company's sources can serve (`servableModels`), strongest first (the existing ranking), a few from each company, only while the pool has room: a named model is never displaced and the pool never grows past its limit.
import { modelCompany, type ModelIdentifier } from "@agentx/contracts";
import { candidatesOf } from "../rovara-code/critic.js";

export const STAGE_POOL_MAX = 23;
const PER_COMPANY = 3;
const key = (model: ModelIdentifier): string => `${model.provider}\0${model.modelId}`;

/** The servable models to add to a pool already holding `have`, in the order they should be added. Allowed models only (not forbidden, inside the approved list when the project has one). */
export function reviewDefaultExtras(input: { servable: readonly ModelIdentifier[]; approved: readonly ModelIdentifier[] | undefined; forbidden: readonly ModelIdentifier[]; have: ReadonlySet<string> }): ModelIdentifier[] {
  const ranked = candidatesOf({ approved: input.approved, forbidden: input.forbidden }, input.servable);
  const byCompany = new Map<string, ModelIdentifier[]>();
  for (const model of ranked) {
    const company = modelCompany(model) === "other" ? `other:${model.provider}` : modelCompany(model);
    byCompany.set(company, [...(byCompany.get(company) ?? []), model]);
  }
  // Round-robin by the strength of each company's best model, so a full pool still holds every company's strongest.
  const out: ModelIdentifier[] = [];
  const room = Math.max(0, STAGE_POOL_MAX - input.have.size);
  for (let round = 0; round < PER_COMPANY; round += 1) {
    for (const list of byCompany.values()) {
      const model = list[round];
      if (model !== undefined && !input.have.has(key(model)) && out.length < room) out.push(model);
    }
  }
  return out;
}
