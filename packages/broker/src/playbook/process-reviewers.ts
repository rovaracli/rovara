// "How we work" (H4 fix round 1): what the reviewing stages of a project's process see. The plan check and the code and security reviewers of a run whose recipe has a process layer in its
// chain receive Rovara's built-in layers and the instructions written on the stage itself, but not the whole-agent ("project-wide") layers the process layer wrote: the project can steer how
// work is built, but cannot steer, through a general rule, the stages that check it. Any other recipe, and any other step, gets every layer as before.
import type { InstructionLayer, ResolvedRecipe, ResolvedStep } from "@agentx/contracts";

/** The stages that check work: the plan check (`plan_critic`) and the review step, which runs the code and the security reviewer. */
const isReviewingStage = (step: ResolvedStep | undefined): boolean => step !== undefined && (step.kind === "plan_critic" || step.kind === "review");

/**
 * The whole-agent instruction layers `step` is given, base agent first. For a reviewing stage of a recipe with a process layer in its chain, the layers that process layer wrote are left
 * out (a layer is tied to its writer by the agent's name, which is unique in the company, and the chain entry the resolver marked `process`).
 */
export function wholeAgentLayers(recipe: ResolvedRecipe, step: ResolvedStep | undefined): InstructionLayer[] {
  if (!isReviewingStage(step)) return recipe.instructions;
  const written = new Set(recipe.chain.filter((entry) => entry.process === true && !entry.builtin).map((entry) => entry.name));
  return written.size === 0 ? recipe.instructions : recipe.instructions.filter((layer) => !written.has(layer.agentName));
}
