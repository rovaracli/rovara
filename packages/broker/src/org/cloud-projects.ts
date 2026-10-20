// Ruling R55: an owner or admin of a cloud org creates a project from a repository. The shared GitHub App sees many repositories,
// so the repository's owner must be the org's operator-set GitHub owner, and the project is built here, from the repository alone,
// the way `agentx project add` builds it. A later plan replaces the owner check with a per-org GitHub App installation.
import {
  AgentXNameSchema,
  DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  Ec2RuntimeBindingSchema,
  ProjectDefinitionSchema,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  agentXError,
  agentxRepositoryName,
  parseCommandLine,
  type Ec2RuntimeBinding,
  type OrgRecord,
  type ProjectCommand,
  type ProjectDefinition,
} from "@agentx/contracts";
import { z } from "zod";

/** Where a cloud org's projects run, and the credential their repositories use: the foundation's, the same for every org. */
export interface CloudProjectDefaults {
  runtimeBinding: Ec2RuntimeBinding;
  /** The built-in GitHub App credential's reference. */
  githubCredentialRef: string;
}

// What `agentx project add` registers: 20 GiB gp3 volumes.
const VOLUME_SIZE_GIB = 20;
const VOLUME_TYPE = "gp3";

/**
 * The cloud project defaults from the control plane's environment, or undefined when it names none (then project creation answers
 * RUNTIME_UNAVAILABLE). EC2_WORKER_SUBNETS is the foundation's Ec2WorkerSubnets output: availabilityZone=subnetId pairs.
 */
export function cloudProjectDefaultsFromEnvironment(env: Record<string, string | undefined>): CloudProjectDefaults | undefined {
  const launchTemplateId = env.EC2_WORKER_LAUNCH_TEMPLATE_ID;
  const subnets = env.EC2_WORKER_SUBNETS;
  const githubCredentialRef = env.GITHUB_APP_CREDENTIAL_REF;
  if (!launchTemplateId || !subnets || !githubCredentialRef) return undefined;
  const parsed = Ec2RuntimeBindingSchema.safeParse({
    deploymentMode: "ec2-ebs",
    launchTemplateId,
    subnets: subnets.split(",").map((pair) => {
      const [availabilityZone, subnetId] = pair.trim().split("=");
      return { availabilityZone, subnetId };
    }),
    volumeSizeGiB: VOLUME_SIZE_GIB,
    volumeType: VOLUME_TYPE,
  });
  return parsed.success ? { runtimeBinding: parsed.data, githubCredentialRef } : undefined;
}

const COMMAND_MAX_LENGTH = 500;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

const CreateProjectBodySchema = z.object({
  repository: z.string().regex(REPOSITORY, "must be owner/name").refine((value) => !/\/(\.{1,2}|\.git)$/.test(value), "must be owner/name"),
  name: AgentXNameSchema.optional(),
  setupCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
  testCommand: z.string().max(COMMAND_MAX_LENGTH).optional(),
}).strict();

export interface CreateProjectInput {
  owner: string;
  repositoryName: string;
  name?: string;
  setupCommand?: string;
  testCommand?: string;
}

/** The body of POST /v1/dev/projects; a refusal names the field and what is wrong with it, never the value. */
export function parseCreateProjectBody(body: unknown): CreateProjectInput {
  const parsed = CreateProjectBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const [, owner, repositoryName] = REPOSITORY.exec(parsed.data.repository) as unknown as [string, string, string];
  return {
    owner,
    repositoryName: repositoryName.endsWith(".git") ? repositoryName.slice(0, -4) : repositoryName,
    ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    ...(parsed.data.setupCommand === undefined ? {} : { setupCommand: parsed.data.setupCommand }),
    ...(parsed.data.testCommand === undefined ? {} : { testCommand: parsed.data.testCommand }),
  };
}

/**
 * The one place that says which repositories an org may create projects for (ruling R55): those under the org's allowed GitHub
 * owner, compared without regard to case. An org with none cannot create projects. Swap this function when each org has its own
 * GitHub App installation.
 */
export function requireAllowedGithubOwner(org: Pick<OrgRecord, "githubOwner">, repositoryOwner: string): void {
  if (org.githubOwner === undefined) {
    throw agentXError("FORBIDDEN", "your organization has no GitHub organization connected yet; ask Rovara support to connect your GitHub organization");
  }
  if (org.githubOwner.toLowerCase() !== repositoryOwner.toLowerCase()) {
    throw agentXError("FORBIDDEN", `your organization can create projects only for repositories under ${org.githubOwner}; ask Rovara support to connect another GitHub organization`);
  }
}

/** The project definition `agentx project add` builds for a repository, from what the GitHub App says about it. */
export function cloudProjectDefinition(input: {
  input: CreateProjectInput;
  repository: { fullName: string; defaultBranch: string };
  githubCredentialRef: string;
}): ProjectDefinition {
  const repoName = agentxRepositoryName(input.input.repositoryName);
  const path = `repo/${repoName}`;
  const typed = (line: string | undefined, timeoutSeconds: number): ProjectCommand[] => (line === undefined || line.trim() === "" ? [] : [parseCommandLine(line, path, timeoutSeconds)]);
  return ProjectDefinitionSchema.parse({
    name: input.input.name ?? repoName,
    revision: 1,
    repositories: [{ name: repoName, url: `https://github.com/${input.repository.fullName}.git`, path, defaultBranch: input.repository.defaultBranch, credentialRef: input.githubCredentialRef }],
    setup: typed(input.input.setupCommand, SETUP_TIMEOUT),
    readiness: typed(input.input.testCommand, TEST_TIMEOUT),
    orchestratorInstructions: DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  });
}
