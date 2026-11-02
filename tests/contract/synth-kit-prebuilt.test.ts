// SK-4 minors: the kit's stand-in for NodejsFunction refuses what it cannot model, and the approval summary says CDK's own validation was not run.
import { App, Stack } from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { NodejsFunction, registerPrebuiltCode } from "../../scripts/release/synth-kit/prebuilt-code.js";

describe("the kit's NodejsFunction stand-in", () => {
  const stack = () => new Stack(new App(), "S");
  const asset = "a".repeat(64);

  it("builds a function from the code map (positive control)", () => {
    registerPrebuiltCode([{ path: "S/F", assetId: asset }]);
    expect(() => new NodejsFunction(stack(), "F", { runtime: Runtime.NODEJS_22_X })).not.toThrow();
  });

  it("refuses a function that sets awsSdkConnectionReuse, true or false: the real class would add an environment variable the stand-in does not", () => {
    registerPrebuiltCode([{ path: "S/G", assetId: asset }]);
    for (const value of [true, false]) {
      expect(() => new NodejsFunction(stack(), "G", { runtime: Runtime.NODEJS_22_X, awsSdkConnectionReuse: value })).toThrow(/awsSdkConnectionReuse/);
    }
  });

  it("refuses a function the code map does not name", () => {
    registerPrebuiltCode([]);
    expect(() => new NodejsFunction(stack(), "H", { runtime: Runtime.NODEJS_22_X })).toThrow(/no prebuilt code for the function S\/H/);
  });
});
