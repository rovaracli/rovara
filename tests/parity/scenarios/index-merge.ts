// Scenarios added by the merge tracking, branch sync, merge conflicts lane. One file each in this folder, named `merge-<what>.ts`, listed here.
import type { Scenario } from "../harness/types.js";
import mergeBaseDriftAutofix from "./merge-base-drift-autofix.js";

export const MERGE_SCENARIOS: readonly Scenario[] = [mergeBaseDriftAutofix];
