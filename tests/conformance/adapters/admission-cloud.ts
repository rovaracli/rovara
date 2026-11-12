// Convergence lane A5: Cloud's Admission adapter under Code's admission conformance suite.
import { defineCloudAdapter } from "../registry.js";
import { admissibleCall, moneyAdmission, refusedCall } from "./money-world.js";

export const cloudAdmission = defineCloudAdapter({
  port: "admission",
  name: "Cloud spend holds",
  harness: { create: async () => moneyAdmission(), admissible: admissibleCall, refused: refusedCall, enforcesCost: true },
});
