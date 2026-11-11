// The org every contract-test broker harness serves. A harness names its install "staging" (the
// developer sign-in's environment), so the install's single org (ruling R3) is derived from that.
import { singleOrgIdForEnv } from "@rovara-code/contracts";
import { projectPk } from "@rovara-code/contracts";

export const TEST_ENV = "staging";
export const TEST_ORG = singleOrgIdForEnv(TEST_ENV);

/** The partition of a project of the harness's org (`projectPk`): where its revisions, its E2E accounts and its AI navigation day budget live. */
export const testProjectPk = (name: string) => projectPk(TEST_ORG, name);
