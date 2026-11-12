// Scenarios added by the spend limits, approvals, erasure, multi-project companies lane. One file each in this folder, named `people-money-<what>.ts`, listed here.
import type { Scenario } from "../harness/types.js";
import spendFullPath from "./people-money-spend-full-path.js";
import limitFamily from "./people-money-limit-family.js";
import spendRoomShort from "./people-money-spend-room-short.js";

export const PEOPLE_MONEY_SCENARIOS: readonly Scenario[] = [spendRoomShort, spendFullPath, limitFamily];
