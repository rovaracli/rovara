/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the test breaks a plain CloudFormation template at a path */
// Review tests (lead 4 Opus security, P8): attacks the builder's suite did not cover.
import { describe, it } from "vitest";
import { GW, GWS, NEW, cloudInput, stackIn } from "./fixtures-index.ts";
import { attack } from "./helpers.ts";

const serveImage = (i: Record<string, any>, value: unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
  stackIn(i, GWS).newTemplate.Resources[GW.serve].Properties.ContainerDefinitions[0].Image = value;
};

describe("R3 truncated ServeTask: the template must not move the image (the row cannot show it)", () => {
  it("the Image swapped to another account's repo with a verified digest", () => attack(cloudInput, (i) => serveImage(i, `999999999999.dkr.ecr.us-west-2.amazonaws.com/evil@${NEW.gateway}`), "row-rejected", "F"));
  it("the Image swapped to a public registry image", () => attack(cloudInput, (i) => serveImage(i, "docker.io/evil/miner:latest"), "row-rejected", "F"));
  it("the Image expression rewritten to drop the ImageDigest parameter", () => attack(cloudInput, (i) => serveImage(i, { "Fn::Join": ["", [{ Ref: "AWS::AccountId" }, ".dkr.ecr.us-west-2.amazonaws.com/rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc@", "sha256:" + "0".repeat(64)]] }), "row-rejected", "F"));
});
