// Company setup recipes as a proposal source (SH30): the install switch `sp`. Leaf module (no broker imports). A packed broker setting (stack parameter SetupRecipesEnabled, "0" by default) that reaches the broker
// as SETUP_RECIPES_ENABLED, on only when it is exactly "1". Off is today's flow: no recipe is offered to a setup run, so nothing a recipe could add is proposed or pre-approved. (Writing and approving recipes, the
// SH29 authority, is a company admin's act and is not behind this switch; what the switch gates is USING them.)
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether company recipes are offered to setup runs in this environment. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const setupRecipesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.setupRecipes.variable]);
