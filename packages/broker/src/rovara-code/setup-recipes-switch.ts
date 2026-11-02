// Company setup recipes as a proposal source (SH30): the install switch `sp`. Leaf module (no broker imports). A packed broker setting (stack parameter SetupRecipesEnabled, "0" by default) that reaches the broker
// as SETUP_RECIPES_ENABLED, on only when it is exactly "1". Off is today's flow: no recipe is offered to a setup run, so nothing a recipe could add is proposed or pre-approved, no host is marked, and the recipe
// routes (list, share, approve, revoke, scope) answer "not found" like any unknown path. (The authority around recipes is a company admin's act, SH29, but it is only reachable while this switch is on.)
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether company recipes are offered to setup runs in this environment. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const setupRecipesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.setupRecipes.variable]);
