// Test services (test-services.md TS37): the install switches `tx` (test services), `ta` (test accounts) and `pj` (project images). Leaf module (no broker imports), so the dependency routes, the task start, the dispatch payload
// and the setup agent can all read them. Each is a packed broker setting (stack parameters TestServicesEnabled, TestAccountsEnabled and ProjectImagesEnabled, "0" by default) that reaches the broker as TEST_SERVICES_ENABLED,
// TEST_ACCOUNTS_ENABLED and PROJECT_IMAGES_ENABLED, and each is on only when it is exactly "1". Off is today's flow, byte for byte: nothing new is reachable and every refusal stays as it is. Nothing reads them yet.
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether dependencies get a backing for test runs. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const testServicesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.testServices.variable]);

/** Whether a project may use the customer's own test accounts. Anything but exactly "1" is off. It does not imply `tx`: a reader that needs both asks both. */
export const testAccountsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.testAccounts.variable]);

/** Whether a project may bring its own images. Anything but exactly "1" is off. It does not imply `tx`: a reader that needs both asks both. */
export const projectImagesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.projectImages.variable]);
