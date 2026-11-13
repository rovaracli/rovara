// Scenarios added by the second review, design review, e2e, parallel parts and lessons lane. One file each in this folder, named `features-a-<what>.ts`, listed here.
import type { Scenario } from "../harness/types.js";
import partsWithUnderstand from "./features-a-parallel-parts-understand.js";

export const FEATURES_A_SCENARIOS: readonly Scenario[] = [partsWithUnderstand];
