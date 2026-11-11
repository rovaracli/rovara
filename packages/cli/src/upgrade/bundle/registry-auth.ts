// The install's own ECR registry credential for skopeo, shared by every step that copies an image into the install's registry (the Enterprise bundle loader, load-images.ts, and the Public
// install's copy of the embedder image, deploy/copy-embedder-image.ts). The credential comes from ECR and goes to skopeo in a 0600 file in a 0700 directory, never on its command line where
// any local user could read it (review M2); the caller removes the directory when it is done.
import { GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { agentXError } from "@rovara-code/contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OwnRegistryAuth {
  /** `<account>.dkr.ecr.<region>.amazonaws.com`: exactly this install's own registry. */
  registry: string;
  /** The directory that holds `authFile`; the caller removes it. */
  authDir: string;
  authFile: string;
  /** The registry password, so the caller can redact it from command output. */
  password: string;
}

/** Gets ECR's credential and writes it for skopeo. Refuses a registry other than the install's own account and region. */
export async function openOwnRegistryAuth(input: { ecr: { send(command: unknown): Promise<unknown> }; account: string; region: string }): Promise<OwnRegistryAuth> {
  const { ecr, account, region } = input;
  const auth = ((await ecr.send(new GetAuthorizationTokenCommand({}))) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> }).authorizationData?.[0];
  if (auth?.authorizationToken === undefined || auth.proxyEndpoint === undefined) throw agentXError("CONFIG_INVALID", "ECR gave no registry credential; nothing was copied");
  const password = Buffer.from(auth.authorizationToken, "base64").toString("utf8").replace(/^AWS:/, "");
  const registry = auth.proxyEndpoint.replace(/^https:\/\//, "");
  if (!/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(registry) || !registry.startsWith(`${account}.dkr.ecr.${region}.`)) {
    throw agentXError("CONFIG_INVALID", "ECR named a registry other than this install's own account and region; nothing was copied");
  }
  const authDir = await mkdtemp(join(tmpdir(), "rovara-registry-auth-"));
  const authFile = join(authDir, "auth.json");
  try {
    await writeFile(authFile, JSON.stringify({ auths: { [registry]: { auth: auth.authorizationToken } } }), { mode: 0o600 });
  } catch (error) {
    await rm(authDir, { recursive: true, force: true });
    throw error;
  }
  return { registry, authDir, authFile, password };
}
