// Enterprise foundations E2: the edition of an install, as `rovara init`, `rovara deploy` and `rovara upgrade` carry it into the CDK synth.
//
// The foundation stack records an Enterprise install's edition in `/agentx/<env>/edition` (infra/lib/production-foundation.ts). An install's edition is set once:
//  - a deploy that asks for another edition than the recorded one is refused (`assertEditionUnchanged`);
//  - a deploy that asks for none but finds a record uses the recorded one, so a redeploy never drops the stamp from the functions (that would turn an Enterprise
//    install into one with no edition gates, silently);
//  - an unreadable record is refused, never read as "no record".
import { EditionSchema, agentXError, assertEditionUnchanged, editionAtSynth, type Edition } from "@agentx/contracts";
import { CLOUD_NEEDS_CDK_MESSAGE } from "./answer-schemas.js";
import type { ParameterStore } from "../environments/parameter-store.js";

export const editionRecordName = (env: string): string => `/agentx/${env}/edition`;

export const EDITION_NEEDS_CDK_MESSAGE = "The prebuilt templates carry no edition. An install with an edition (Enterprise) must be synthesized from source: use --engine cdk with --source.";

/** The edition the foundation recorded for this environment, or undefined when it recorded none (an install deployed before editions, or the hosted cloud). */
export async function readRecordedEdition(store: ParameterStore, env: string): Promise<Edition | undefined> {
  const stored = await store.get(editionRecordName(env));
  if (stored === undefined) return undefined;
  const parsed = EditionSchema.safeParse(stored.value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `The edition recorded for environment ${env} (${editionRecordName(env)}) is not "enterprise" or "public"; fix or remove that parameter before deploying.`);
  return parsed.data;
}

/**
 * The edition a deploy of `env` synthesizes with: the explicit request, else the recorded one, else none (today's behaviour). Refuses a changed edition,
 * an edition that disagrees with the hosted cloud, and an edition on the prebuilt-templates engine (which cannot carry one).
 */
export async function resolveDeployEdition(input: { store: ParameterStore; env: string; engine: "templates" | "cdk"; cloud: boolean; requested?: Edition | undefined }): Promise<Edition | undefined> {
  const recorded = await readRecordedEdition(input.store, input.env);
  if (input.requested !== undefined) assertEditionUnchanged(recorded, input.requested);
  const effective = input.requested ?? recorded;
  // The same cross-checks the synth makes (Enterprise inside the hosted cloud, Public outside it), before anything is built or deployed.
  editionAtSynth({ explicit: effective, cloud: input.cloud });
  if (effective !== undefined && input.engine === "templates") throw agentXError("CONFIG_INVALID", effective === "enterprise" ? EDITION_NEEDS_CDK_MESSAGE : CLOUD_NEEDS_CDK_MESSAGE);
  return effective;
}
