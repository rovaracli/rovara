// A Public install's embedder image: copied from the release's public image into the install's own `rovara-bundle/<env>/embedder` repository, digest preserved, before the control plane deploys.
// Why: Lambda cannot create a function from a pull-through cache repository (ECR user guide: "AWS Lambda doesn't support pulling container images from Amazon ECR using a pull through cache
// rule."). The copy is idempotent, keeps the registry credential off the command line, and refuses when the repository does not hold exactly the release's digest afterwards.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { BatchGetImageCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { describe, expect, it } from "vitest";
import { checkEmbedderCopyPrerequisites, copyEmbedderImage } from "../../packages/cli/src/deploy/copy-embedder-image.js";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";

const DIGEST = `sha256:${"e".repeat(64)}`;
const SOURCE = `public.ecr.aws/agentx/agentx-embedder@${DIGEST}`;
const REPOSITORY = "rovara-bundle/staging/embedder";
const PASSWORD = "registry-password-for-test";

interface Sent { name: string; input: Record<string, unknown> }
const DOCKER_V2 = "application/vnd.docker.distribution.manifest.v2+json";
function fakeEcr(options: { repositoryExists?: boolean; presentBefore?: boolean; presentAfterCopy?: boolean; mediaType?: string } = {}): { ecr: { send(command: unknown): Promise<unknown> }; sent: Sent[]; copied: () => void } {
  const sent: Sent[] = [];
  let hasImage = options.presentBefore === true;
  return {
    sent,
    copied: () => { hasImage = options.presentAfterCopy !== false; },
    ecr: {
      async send(command: unknown) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        sent.push({ name, input: (command as { input: Record<string, unknown> }).input });
        if (command instanceof GetAuthorizationTokenCommand) return { authorizationData: [{ authorizationToken: Buffer.from(`AWS:${PASSWORD}`).toString("base64"), proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com" }] };
        if (command instanceof BatchGetImageCommand) {
          if (options.repositoryExists === false) throw Object.assign(new Error("no such repository"), { name: "RepositoryNotFoundException" });
          return { images: hasImage ? [{ imageId: { imageDigest: DIGEST }, imageManifestMediaType: options.mediaType ?? DOCKER_V2 }] : [] };
        }
        throw new Error(`unexpected ${name}`);
      },
    },
  };
}
function fakeRunner(onRun: () => void, fail?: Error): { runner: CommandRunner; calls: Array<{ command: string; args: string[]; display: string; authFile: string; mode: number; dirMode: number }> } {
  const calls: Array<{ command: string; args: string[]; display: string; authFile: string; mode: number; dirMode: number }> = [];
  return {
    calls,
    runner: {
      async run(command, args, options) {
        const authFile = args[args.indexOf("--dest-authfile") + 1]!;
        calls.push({ command, args, display: options.display, authFile, mode: statSync(authFile).mode & 0o777, dirMode: statSync(dirname(authFile)).mode & 0o777 });
        // The credential file exists while skopeo runs, holds the password for the install's own registry, and is private to the user.
        const file = readFileSync(calls.at(-1)!.authFile, "utf8");
        expect(file).toContain("123456789012.dkr.ecr.us-east-1.amazonaws.com");
        if (fail !== undefined) throw fail;
        onRun();
        return { stdout: "" };
      },
    },
  };
}
const input = (ecr: ReturnType<typeof fakeEcr>, runner: CommandRunner, write: (line: string) => void = () => undefined) => ({ source: SOURCE, env: "staging", account: "123456789012", region: "us-east-1", ecr: ecr.ecr, runner, write });

describe("copying the release's embedder image into the install's own repository (a Public install)", () => {
  it("copies it with skopeo, every platform, digest preserved, into rovara-bundle/<env>/embedder, with the credential in a file and never in the command", async () => {
    const ecr = fakeEcr();
    const { runner, calls } = fakeRunner(() => ecr.copied());
    expect(await copyEmbedderImage(input(ecr, runner))).toBe("copied");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("skopeo");
    expect(call.args.slice(0, 3)).toEqual(["copy", "--all", "--preserve-digests"]);
    // the source is the release's PUBLIC image by digest; the target is the install's own registry, outside any pull-through prefix
    expect(call.args).toContain(`docker://${SOURCE}`);
    const target = call.args.at(-1)!;
    expect(target).toBe(`docker://123456789012.dkr.ecr.us-east-1.amazonaws.com/${REPOSITORY}:${"e".repeat(32)}`);
    expect(target).not.toContain("/agentx-staging/");
    expect(JSON.stringify(call)).not.toContain(PASSWORD);
    // present by digest before (nothing), and checked by digest after: the repository holds exactly the release's digest
    const gets = ecr.sent.filter((entry) => entry.name === "BatchGetImageCommand");
    expect(gets).toHaveLength(2);
    // the lookups accept every manifest type, so an index is SEEN (and refused) rather than reported as missing
    for (const get of gets) expect(get.input).toEqual({ repositoryName: REPOSITORY, imageIds: [{ imageDigest: DIGEST }], acceptedMediaTypes: [DOCKER_V2, "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.index.v1+json"] });
    // the credential: a 0600 file in a 0700 directory while skopeo runs, and the directory is gone afterwards
    expect(call.mode).toBe(0o600);
    expect(call.dirMode).toBe(0o700);
    expect(existsSync(dirname(call.authFile))).toBe(false);
  });

  it("removes the credential directory when skopeo fails, too", async () => {
    const ecr = fakeEcr();
    const { runner, calls } = fakeRunner(() => undefined, new Error("skopeo copy exited with code 1: 404 Not Found"));
    await expect(copyEmbedderImage(input(ecr, runner))).rejects.toThrow(/exited with code 1: 404 Not Found/);
    expect(calls).toHaveLength(1);
    expect(existsSync(dirname(calls[0]!.authFile))).toBe(false);
  });

  it("refuses a multi-platform index, as copied and as already present (Lambda runs only a single-platform image)", async () => {
    for (const mediaType of ["application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.index.v1+json"]) {
      const copiedIndex = fakeEcr({ mediaType });
      const { runner } = fakeRunner(() => copiedIndex.copied());
      await expect(copyEmbedderImage(input(copiedIndex, runner)), mediaType).rejects.toThrow(/multi-platform index.*linux\/arm64 image manifest.*Nothing was deployed/s);
      const present = fakeEcr({ presentBefore: true, mediaType });
      await expect(copyEmbedderImage(input(present, fakeRunner(() => undefined).runner)), mediaType).rejects.toThrow(/multi-platform index/);
    }
    // an OCI image manifest is a single image and passes
    const oci = fakeEcr({ mediaType: "application/vnd.oci.image.manifest.v1+json" });
    expect(await copyEmbedderImage(input(oci, fakeRunner(() => oci.copied()).runner))).toBe("copied");
  });

  it("is idempotent: an image already in the repository by that digest is left alone (no credential, no copy)", async () => {
    const ecr = fakeEcr({ presentBefore: true });
    const { runner, calls } = fakeRunner(() => undefined);
    const lines: string[] = [];
    expect(await copyEmbedderImage(input(ecr, runner, (line) => lines.push(line)))).toBe("present");
    expect(calls).toEqual([]);
    expect(ecr.sent.some((entry) => entry.name === "GetAuthorizationTokenCommand")).toBe(false);
    expect(lines.join("\n")).toContain("already in rovara-bundle/staging/embedder");
  });

  it("refuses, and says what to do, when the repository is missing (the access stack makes it) or the copy did not leave the release's digest there", async () => {
    const missing = fakeEcr({ repositoryExists: false });
    await expect(copyEmbedderImage(input(missing, fakeRunner(() => undefined).runner))).rejects.toThrow(/rovara-bundle\/staging\/embedder does not exist.*access stack.*Nothing was copied/s);
    const wrong = fakeEcr({ presentAfterCopy: false });
    const { runner } = fakeRunner(() => wrong.copied());
    await expect(copyEmbedderImage(input(wrong, runner))).rejects.toThrow(/does not hold sha256:e+.*Nothing was deployed/s);
  });

  it("refuses a source that is not a public image pinned by digest, before touching the registry", async () => {
    for (const source of ["public.ecr.aws/agentx/agentx-embedder:latest", `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/agentx/agentx-embedder@${DIGEST}`, `ghcr.io/x/y@${DIGEST}`]) {
      const ecr = fakeEcr();
      await expect(copyEmbedderImage({ ...input(ecr, fakeRunner(() => undefined).runner), source }), source).rejects.toThrow(/not a public\.ecr\.aws\/<repository>@sha256:<digest> reference/);
      expect(ecr.sent).toEqual([]);
    }
  });

  it("names skopeo only when it could not start (a spawn ENOENT); a registry's own \"not found\" is never reported as a missing tool", async () => {
    const missing = fakeEcr();
    await expect(copyEmbedderImage(input(missing, fakeRunner(() => undefined, new Error("skopeo copy --all could not start: spawn skopeo ENOENT")).runner))).rejects.toThrow(/skopeo is needed to copy the embedder image.*Nothing was deployed/s);
    const registryError = fakeEcr();
    await expect(copyEmbedderImage(input(registryError, fakeRunner(() => undefined, new Error("skopeo copy exited with code 1:\nmanifest unknown: 404 Not Found: tool not found in registry")).runner))).rejects.toThrow(/404 Not Found/);
    await expect(copyEmbedderImage(input(fakeEcr(), fakeRunner(() => undefined, new Error("skopeo copy exited with code 1:\nmanifest unknown: 404 Not Found")).runner))).rejects.not.toThrow(/skopeo is needed/);
  });

  it("says nothing was copied (not that no image was loaded) when ECR gives no credential or names another registry", async () => {
    const withToken = (data: unknown) => ({ send: async (command: unknown) => (command instanceof GetAuthorizationTokenCommand ? data : { images: [] }) });
    await expect(copyEmbedderImage({ ...input(fakeEcr(), fakeRunner(() => undefined).runner), ecr: withToken({ authorizationData: [] }) })).rejects.toThrow(/no registry credential; nothing was copied/);
    const other = withToken({ authorizationData: [{ authorizationToken: Buffer.from("AWS:x").toString("base64"), proxyEndpoint: "https://999999999999.dkr.ecr.us-east-1.amazonaws.com" }] });
    await expect(copyEmbedderImage({ ...input(fakeEcr(), fakeRunner(() => undefined).runner), ecr: other })).rejects.toThrow(/other than this install's own account and region; nothing was copied/);
  });
});

describe("the checks before any stack deploys", () => {
  const runnerThat = (behaviour: "ok" | "missing" | "broken"): CommandRunner => ({
    async run(command, args) {
      expect([command, ...args]).toEqual(["skopeo", "--version"]);
      if (behaviour === "missing") throw new Error("skopeo --version could not start: spawn skopeo ENOENT");
      if (behaviour === "broken") throw new Error("skopeo --version exited with code 1");
      return { stdout: "skopeo version 1.14.0" };
    },
  });
  it("passes when skopeo runs and ECR gives a credential", async () => {
    const ecr = fakeEcr();
    await checkEmbedderCopyPrerequisites({ runner: runnerThat("ok"), ecr: ecr.ecr });
    expect(ecr.sent.map((entry) => entry.name)).toEqual(["GetAuthorizationTokenCommand"]);
  });
  it("refuses, in plain words and before anything is deployed, when skopeo is missing or broken, or ECR will not give a credential", async () => {
    await expect(checkEmbedderCopyPrerequisites({ runner: runnerThat("missing"), ecr: fakeEcr().ecr })).rejects.toThrow(/skopeo is needed.*not found on this machine.*Nothing was deployed/s);
    await expect(checkEmbedderCopyPrerequisites({ runner: runnerThat("broken"), ecr: fakeEcr().ecr })).rejects.toThrow(/skopeo --version` failed.*Nothing was deployed/s);
    const denied = { send: async () => { throw Object.assign(new Error("not allowed"), { name: "AccessDeniedException" }); } };
    await expect(checkEmbedderCopyPrerequisites({ runner: runnerThat("ok"), ecr: denied })).rejects.toThrow(/ecr:GetAuthorizationToken.*Nothing was deployed/s);
  });
});
