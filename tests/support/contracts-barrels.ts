// Convergence W0-3: the contracts are two packages now (`@rovara-code/contracts`, Rovara Code's, and `@agentx/cloud-contracts`, Cloud's own). A few tests treat "the contracts" as one
// module (they list its names, or look one up by a string). This is that one module: Code's names, then Cloud's over them, so a name both define is Cloud's (the same rule every importer
// follows; see tests/contract/cloud-contracts-no-duplicate-names.test.ts). Tests that import named values import them from the package that owns them, not from here.
import * as cloud from "@agentx/cloud-contracts";
import * as code from "@rovara-code/contracts";

export const allContracts: typeof code & typeof cloud = { ...code, ...cloud };
