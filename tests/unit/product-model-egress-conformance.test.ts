// TE-F1e: F1-a's `model-egress` conformance suite and the two-company kit (DECISIONS 150(c)), run against the PRODUCTION chain: the worker's Cloud adapter, the wire, and the ProductModelEgress function
// composed with fakes (tests/support/product-model-egress-world.ts). The suite is Code's own file (vendor, byte for byte); nothing here weakens or skips one of its checks.
import { runContract } from "../../vendor/rovara-code/packages/testing/dist/ports/plugin-contract-kit.js";
import { modelEgressChecks } from "../../vendor/rovara-code/packages/testing/dist/ports/model-egress-conformance.js";
import { cloudEgressWorld } from "../support/product-model-egress-world.js";

runContract("ProductModelEgress function behind the Cloud adapter", modelEgressChecks, () => cloudEgressWorld());
