import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  assertNoUntrustedRoutingFields,
  authorizeProject,
  authorizeWorkspace,
  JwtAuthenticator,
} from "../../packages/broker/src/index.js";

async function signedIdentity(subject: string, groups: string[] = []) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({ groups })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://issuer.example.com")
    .setAudience("agentx")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const authenticator = new JwtAuthenticator(
    {
      issuer: "https://issuer.example.com",
      audience: "agentx",
      adminClaim: "groups",
      adminValues: ["agentx-admin"],
    },
    getKey,
  );
  return authenticator.authenticate(token);
}

describe("authentication and authorization", () => {
  it("derives stable owner identity from verified issuer and subject", async () => {
    const first = await signedIdentity("alice");
    const second = await signedIdentity("alice");
    expect(first.ownerKey).toBe(second.ownerKey);
    expect(first.subject).toBe("alice");
    expect(first.isAdministrator).toBe(false);
  });

  it("recognizes only verified administrator claims", async () => {
    expect((await signedIdentity("admin", ["agentx-admin"])).isAdministrator).toBe(true);
  });

  it("denies project and workspace access without matching membership and ownership", async () => {
    const alice = await signedIdentity("alice");
    expect(() => authorizeProject(alice, "payments", [{ ownerKey: alice.ownerKey, project: "shop" }])).toThrow(
      /NOT_FOUND/,
    );
    expect(() => authorizeWorkspace(alice, { ownerKey: "bob-key", projectName: "payments" })).toThrow(
      /NOT_FOUND/,
    );
  });

  it("never lets two missing orgs match: a caller with no org uses no workspace, even an owner's own org-less one", async () => {
    const alice = await signedIdentity("alice");
    expect(alice.orgId).toBeUndefined();
    expect(() => authorizeWorkspace(alice, { ownerKey: alice.ownerKey, projectName: "payments" })).toThrow(/NOT_FOUND/);
    expect(() => authorizeWorkspace(alice, { ownerKey: alice.ownerKey, projectName: "payments", orgId: undefined })).toThrow(/NOT_FOUND/);
    // With an org on both sides, the owner and the org must both match.
    const org = "org_aaaaaaaaaaaaaaaaaaaa" as const;
    const inOrg = { ...alice, orgId: org };
    expect(() => authorizeWorkspace(inOrg, { ownerKey: alice.ownerKey, projectName: "payments", orgId: org })).not.toThrow();
    expect(() => authorizeWorkspace(inOrg, { ownerKey: alice.ownerKey, projectName: "payments" })).toThrow(/NOT_FOUND/);
    expect(() => authorizeWorkspace(inOrg, { ownerKey: alice.ownerKey, projectName: "payments", orgId: "org_bbbbbbbbbbbbbbbbbbbb" })).toThrow(/NOT_FOUND/);
  });

  it("rejects client-controlled identity and retired runtime routing fields at any depth", () => {
    expect(() => assertNoUntrustedRoutingFields({ prompt: "ok", nested: { runtimeSessionId: "x" } })).toThrow(
      /runtimeSessionId/,
    );
    expect(() => assertNoUntrustedRoutingFields({ ownerSubject: "bob" })).toThrow(/ownerSubject/);
    expect(() => assertNoUntrustedRoutingFields({
      deploymentMode: "ec2-ebs" as const,
      launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }],
      volumeSizeGiB: 20,
      volumeType: "gp3" as const,
    })).toThrow(
      /deploymentMode/,
    );
    expect(() => assertNoUntrustedRoutingFields({ nested: { provider: "bedrock" } })).toThrow(/provider/);
    expect(() => assertNoUntrustedRoutingFields({ modelId: "server-choice" })).toThrow(/modelId/);
  });
});
