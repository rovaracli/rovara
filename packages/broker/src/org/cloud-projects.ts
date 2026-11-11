// Plan 2, Task 16: an owner or admin of a cloud org creates a project from a repository the org's own GitHub connection reaches (the
// route checks that), and the project is built here, from the repository alone, the way `agentx project add` builds it.
import { CreateProjectBodySchema, DEFAULT_ORCHESTRATOR_INSTRUCTIONS, Ec2RuntimeBindingSchema, SETUP_TIMEOUT, TEST_TIMEOUT, AgentXError, agentXError, agentxRepositoryName, parseCommandLine, type Ec2RuntimeBinding, type ProjectCommand } from "@rovara-code/contracts";
import { ProjectDefinitionSchema, type ProjectDefinition } from "@agentx/cloud-contracts";

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

const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;




export interface CreateProjectInput {
  /** The request's id: a replay of it answers the project it made. */
  requestId: string;
  owner: string;
  repositoryName: string;
  name?: string;
  description?: string;
  /** The setup commands, in order (the body's `setupCommand` is a list of one). */
  setupCommands?: string[];
  /** The test commands, in order (the body's `testCommand` is a list of one). */
  testCommands?: string[];
}

/** The body of POST /v1/app/projects (and its alias POST /v1/dev/projects); a refusal names the field and what is wrong with it, never the value. */
export function parseCreateProjectBody(body: unknown): CreateProjectInput {
  const parsed = CreateProjectBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const [, owner, repositoryName] = REPOSITORY.exec(parsed.data.repository) as unknown as [string, string, string];
  // A command that cannot be run is refused here, before GitHub is asked anything.
  const setupCommands = parsed.data.setupCommands ?? (parsed.data.setupCommand === undefined ? undefined : [parsed.data.setupCommand]);
  const testCommands = parsed.data.testCommands ?? (parsed.data.testCommand === undefined ? undefined : [parsed.data.testCommand]);
  for (const [field, lines, timeout] of [["setupCommand", setupCommands, SETUP_TIMEOUT], ["testCommand", testCommands, TEST_TIMEOUT]] as const) {
    for (const [index, line] of (lines ?? []).entries()) {
      if (line.trim() === "") continue;
      try {
        parseCommandLine(line, "repo/check", timeout);
      } catch (error) {
        // A list names the command's place in it; a single command keeps the field's own name.
        const place = field === "setupCommand" && parsed.data.setupCommands !== undefined ? `setupCommands.${String(index)}` : field === "testCommand" && parsed.data.testCommands !== undefined ? `testCommands.${String(index)}` : field;
        if (error instanceof AgentXError) throw agentXError("CONFIG_INVALID", `${place}: ${error.message.replace(/^[A-Z_]+: /, "")}`);
        throw error;
      }
    }
  }
  return {
    requestId: parsed.data.requestId,
    owner,
    repositoryName: repositoryName.endsWith(".git") ? repositoryName.slice(0, -4) : repositoryName,
    ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
    ...(setupCommands === undefined ? {} : { setupCommands }),
    ...(testCommands === undefined ? {} : { testCommands }),
  };
}

/**
 * The repository entry `agentx project add` builds for a repository, from what the GitHub App says about it; settings use it for an added one.
 * `connection` is what the org's GitHub connection answered (the installation and GitHub's id of the repository): the entry pins them, so a
 * repository that moves to another installation must be connected again on purpose.
 */
export function cloudRepositoryEntry(input: {
  repositoryName: string;
  repository: { fullName: string; defaultBranch: string };
  githubCredentialRef: string;
  connection?: { installationId: number; githubRepositoryId: number };
}): ProjectDefinition["repositories"][number] {
  const name = agentxRepositoryName(input.repositoryName);
  return {
    name, url: `https://github.com/${input.repository.fullName}.git`, path: `repo/${name}`, defaultBranch: input.repository.defaultBranch, credentialRef: input.githubCredentialRef,
    ...(input.connection === undefined ? {} : { installationId: input.connection.installationId, githubRepositoryId: input.connection.githubRepositoryId }),
  };
}

/** The project definition `agentx project add` builds for a repository, from what the GitHub App says about it. */
export function cloudProjectDefinition(input: {
  input: CreateProjectInput;
  repository: { fullName: string; defaultBranch: string };
  githubCredentialRef: string;
  connection: { installationId: number; githubRepositoryId: number };
}): ProjectDefinition {
  const repoName = agentxRepositoryName(input.input.repositoryName);
  const path = `repo/${repoName}`;
  const typed = (lines: string[] | undefined, timeoutSeconds: number): ProjectCommand[] => (lines ?? []).filter((line) => line.trim() !== "").map((line) => parseCommandLine(line, path, timeoutSeconds));
  return ProjectDefinitionSchema.parse({
    name: input.input.name ?? repoName,
    revision: 1,
    repositories: [cloudRepositoryEntry({ repositoryName: input.input.repositoryName, repository: input.repository, githubCredentialRef: input.githubCredentialRef, connection: input.connection })],
    setup: typed(input.input.setupCommands, SETUP_TIMEOUT),
    readiness: typed(input.input.testCommands, TEST_TIMEOUT),
    orchestratorInstructions: DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  });
}
