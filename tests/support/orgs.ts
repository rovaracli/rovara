// The org every contract-test broker harness serves. A harness names its install "staging" (the
// developer sign-in's environment), so the install's single org (ruling R3) is derived from that.
import { singleOrgIdForEnv } from "../../packages/contracts/src/org-node.js";

export const TEST_ENV = "staging";
export const TEST_ORG = singleOrgIdForEnv(TEST_ENV);
