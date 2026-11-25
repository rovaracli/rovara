// CODE_RELEASE (BETA-CLOUD-PLAN 1.3), decided once, in Beta's Preflight, before anything is written.
//   run | skip   typed on a run started by hand: that value wins, as typed.
//   from-trigger the pipeline's default, so what EVERY triggered run carries (a V2 trigger binds no variable). The value is then decided from WHICH SOURCE started the run, which
//                Code's Preflight read from the execution's own record and passed in CODE_CTX (lib/codectx.ts, trigger):
//                  a Cloud release tag push (cloud-tag@<tag>) -> skip: that run releases Cloud only; the Code commit it happens to hold waits for a Code push of its own;
//                  a Code mainline push (code-push)           -> run;
//                  a run started by hand that left the default (manual), a trigger the lookup could not prove (unknown), or no trigger fact at all -> REFUSED: nothing is released.
// A cloud-tag run must also agree with the Cloud ref the same run resolved: the pushed tag IS the tag on the Cloud source commit, or the run is refused.
import { StageError } from "../types.ts";
import type { Inputs } from "./context.ts";
import type { ResolvedRef } from "./refs.ts";

/** The pipeline's CODE_RELEASE default (infra/lib/release-pipeline.ts, CODE_RELEASE_FROM_TRIGGER in Rovara Code). */
export const CODE_RELEASE_FROM_TRIGGER = "from-trigger";

export interface CodeReleaseRequest { request: "run" | "skip"; why: string }

const NAME_IT = "start the run by hand with CODE_RELEASE set to run or skip";

export function decideCodeRelease(inputs: Pick<Inputs, "codeRelease" | "codeTrigger">, resolved: Pick<ResolvedRef, "tag" | "ref">): CodeReleaseRequest {
  if (inputs.codeRelease === "run" || inputs.codeRelease === "skip") return { request: inputs.codeRelease, why: `CODE_RELEASE=${inputs.codeRelease} was named for this run` };
  const trigger = inputs.codeTrigger;
  if (trigger === null) throw new StageError("REFUSED", `CODE_RELEASE=${CODE_RELEASE_FROM_TRIGGER} is decided from which source started the run (the trigger part of CODE_CTX, from Code's Preflight), and none was given, so nothing is released (${NAME_IT})`);
  if (trigger.kind === "code-push") return { request: "run", why: "a Code mainline push started this run" };
  if (trigger.kind === "cloud-tag") {
    if (resolved.ref !== "from-trigger" || resolved.tag !== trigger.tag) {
      throw new StageError("REFUSED", `a Cloud tag push (${trigger.tag}) started this run, but the Cloud ref it resolved is ${resolved.tag} (${resolved.ref}): the pushed tag and the tag on the Cloud source commit must be the same, so nothing is released`);
    }
    return { request: "skip", why: `the Cloud release tag ${trigger.tag} started this run: it releases Cloud only, and the Code commit waits for a Code push of its own` };
  }
  if (trigger.kind === "manual") throw new StageError("REFUSED", `this run was started by hand and left CODE_RELEASE at ${CODE_RELEASE_FROM_TRIGGER}: it cannot tell whether Code is meant to be released, so nothing is released (${NAME_IT})`);
  throw new StageError("REFUSED", `which source started this run could not be established (Code's Preflight could not prove a Cloud tag push, a Code push or a hand start), so nothing is released (${NAME_IT})`);
}
