// Scenarios added by the chains and custom agents lane. One file each in this folder, named `features-d-<what>.ts`, listed here.
import type { Scenario } from "../harness/types.js";
import chainAdmissionRefused from "./features-d-chain-admission-refused.js";
import chainCodeDefaults from "./features-d-chain-code-defaults.js";
import chainRun from "./features-d-chain-run.js";
import chainStartTwice from "./features-d-chain-start-twice.js";
import chainSwitchOff from "./features-d-chain-switch-off.js";
import customAgent from "./features-d-custom-agent.js";
import triggerTwice from "./features-d-trigger-twice.js";

export const FEATURES_D_SCENARIOS: readonly Scenario[] = [chainRun, customAgent, chainAdmissionRefused, chainStartTwice, chainSwitchOff, chainCodeDefaults, triggerTwice];
