// Saved project images (SV wiring): the AWS adapters of the registry's ports. The rules are in ../../test-env/saved-env.ts and saved-env-session.ts; this file only makes the calls.
//   - STS AssumeRole with the inline session policy (the broker's role assumes one of the three fixed-name roles); the credentials it returns are the ONLY credentials any ECR call below is made with, so a call
//     can reach only the one repository the session policy names;
//   - ECR GetAuthorizationToken, DescribeRepositories, GetRepositoryPolicy, DescribeImages, BatchDeleteImage, DeleteRepository and StartImageScan, each with a client built from those session credentials.
// Nothing here keeps a credential, a token or an AWS error's text: an error is mapped to a fixed outcome or rethrown for the caller (which maps it to `unavailable`). The clients are made per call from the
// session's credentials; a test passes `ecr` and `sts` senders instead.
import {
  BatchDeleteImageCommand,
  DeleteRepositoryCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  GetRepositoryPolicyCommand,
  StartImageScanCommand,
} from "@aws-sdk/client-ecr";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { RegistryImage, RegistryPort } from "../../test-env/saved-env.js";
import type { RepositoryDescription, SavedEnvSessionPorts, SessionCredentials } from "../../test-env/saved-env-session.js";

export interface AwsSender { send(command: unknown): Promise<unknown> }
export interface SavedEnvAwsClients {
  /** The broker's own STS client (its role assumes the three session roles). */
  sts: AwsSender;
  /** An ECR client that signs with these session credentials. */
  ecr(credentials: SessionCredentials): AwsSender;
}

export function realSavedEnvAwsClients(region: string): SavedEnvAwsClients {
  const sts = new STSClient({ region });
  return {
    sts: { send: (command) => sts.send(command as never) },
    ecr: (credentials) => {
      const client = new ECRClient({ region, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } });
      return { send: (command) => client.send(command as never) };
    },
  };
}

const named = (error: unknown, ...names: string[]): boolean => error instanceof Error && names.includes(error.name);
/** DescribeImages and BatchDeleteImage list at most this many digests per call. */
const BATCH = 100;
/** The most pages one listing reads (1,000 images a page): a repository holds a handful of images, so more is a damaged registry, not history. */
const LIST_PAGES_MAX = 10;

export function savedEnvRegistryPort(clients: SavedEnvAwsClients): RegistryPort {
  return {
    async listImages(credentials, repository) {
      const ecr = clients.ecr(credentials);
      const out: RegistryImage[] = [];
      let nextToken: string | undefined;
      try {
        for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
          const found = await ecr.send(new DescribeImagesCommand({ repositoryName: repository, maxResults: 1000, ...(nextToken === undefined ? {} : { nextToken }) })) as { imageDetails?: Array<{ imageDigest?: string; imageTags?: string[]; imagePushedAt?: Date }>; nextToken?: string };
          for (const detail of found.imageDetails ?? []) {
            if (typeof detail.imageDigest !== "string") continue;
            out.push({ digest: detail.imageDigest, tags: detail.imageTags ?? [], pushedAt: (detail.imagePushedAt ?? new Date(0)).toISOString() });
          }
          nextToken = found.nextToken;
          if (nextToken === undefined) return out;
        }
      } catch (error) {
        if (named(error, "RepositoryNotFoundException")) return "absent";
        throw error;
      }
      // A listing cut short would let the walk think an image is gone: it is an error, not a short list.
      throw new Error("the registry lists more images than a repository holds");
    },

    async batchDelete(credentials, repository, digests) {
      const ecr = clients.ecr(credentials);
      for (let start = 0; start < digests.length; start += BATCH) {
        const answer = await ecr.send(new BatchDeleteImageCommand({ repositoryName: repository, imageIds: digests.slice(start, start + BATCH).map((imageDigest) => ({ imageDigest })) })) as { failures?: Array<{ failureCode?: string }> };
        // An image that is already gone is deleted; any other failure is not.
        if ((answer.failures ?? []).some((failure) => failure.failureCode !== "ImageNotFound")) throw new Error("the registry did not delete every image");
      }
    },

    async deleteRepository(credentials, repository) {
      try {
        await clients.ecr(credentials).send(new DeleteRepositoryCommand({ repositoryName: repository, force: true }));
        return "deleted";
      } catch (error) {
        if (named(error, "RepositoryNotFoundException")) return "absent";
        throw error;
      }
    },

    async startScan(credentials, repository, digest) {
      await clients.ecr(credentials).send(new StartImageScanCommand({ repositoryName: repository, imageId: { imageDigest: digest } }));
    },
  };
}

/** What the session ports need from the rest of the broker: the approved environment and its Prove report (bound where the stores are), and the clock. */
export interface SavedEnvSessionBindings {
  readApproved: SavedEnvSessionPorts["readApproved"];
  proveHolds: SavedEnvSessionPorts["proveHolds"];
  now(): number;
}

export function savedEnvSessionPorts(clients: SavedEnvAwsClients, bindings: SavedEnvSessionBindings): SavedEnvSessionPorts {
  return {
    async assume(request) {
      const answer = await clients.sts.send(new AssumeRoleCommand({ RoleArn: request.roleArn, RoleSessionName: request.sessionName, Policy: request.policy, DurationSeconds: request.durationSeconds })) as { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } };
      const credentials = answer.Credentials;
      if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) throw new Error("the session was not issued");
      return { credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken }, expiresAtMs: credentials.Expiration.getTime() };
    },

    async authorizationToken(credentials) {
      const answer = await clients.ecr(credentials).send(new GetAuthorizationTokenCommand({})) as { authorizationData?: Array<{ authorizationToken?: string; expiresAt?: Date; proxyEndpoint?: string }> };
      const data = answer.authorizationData?.[0];
      if (data?.authorizationToken === undefined || data.expiresAt === undefined || data.proxyEndpoint === undefined) throw new Error("no registry token");
      // The token is base64 of `AWS:<password>`; only the password is handed on.
      const decoded = Buffer.from(data.authorizationToken, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator < 0 || decoded.slice(0, separator) !== "AWS") throw new Error("not a registry token");
      return { password: decoded.slice(separator + 1), registry: data.proxyEndpoint.replace(/^https:\/\//u, ""), expiresAtMs: data.expiresAt.getTime() };
    },

    async inspectRepository(credentials, repository): Promise<RepositoryDescription | "absent"> {
      const ecr = clients.ecr(credentials);
      let described: { repositories?: Array<{ encryptionConfiguration?: { encryptionType?: string; kmsKey?: string }; imageTagMutability?: string }> };
      try {
        described = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repository] })) as typeof described;
      } catch (error) {
        if (named(error, "RepositoryNotFoundException")) return "absent";
        throw error;
      }
      const found = described.repositories?.[0];
      if (found === undefined) return "absent";
      let policyText: string | undefined;
      try {
        policyText = ((await ecr.send(new GetRepositoryPolicyCommand({ repositoryName: repository }))) as { policyText?: string }).policyText;
      } catch (error) {
        if (!named(error, "RepositoryPolicyNotFoundException")) throw error;
      }
      return { encryptionType: found.encryptionConfiguration?.encryptionType, kmsKey: found.encryptionConfiguration?.kmsKey, imageTagMutability: found.imageTagMutability, policyText };
    },

    readApproved: bindings.readApproved,
    proveHolds: bindings.proveHolds,
    now: bindings.now,
  };
}
