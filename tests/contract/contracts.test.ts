import { describe, expect, it } from "vitest";
import { OperationRequestSchema, ProjectDefinitionSchema, StoredProjectDefinitionSchema, legacyProjectFields, WorkspaceInstanceSchema } from "../../packages/contracts/src/index.js";

const digest = `registry.example.com/payments@sha256:${"a".repeat(64)}`;
function projectDefinition() {
  return {
    name: "payments",
    revision: 1,
    repositories: [
      {
        name: "api",
        url: "https://git.example.com/team/api.git",
        path: "services/api",
        defaultBranch: "main",
        credentialRef: "payments-read",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding remotely.",
  };
}

describe("strict contracts", () => {
  it("accepts a valid versioned project", () => {
    expect(ProjectDefinitionSchema.parse(projectDefinition()).name).toBe("payments");
  });

  it("rejects the retired connection and environment fields, and names them for a caller", () => {
    const legacy = {
      ...projectDefinition(),
      schemaVersion: 2,
      controlPlaneUrl: "https://agentx.example.test",
      auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
      environment: { image: digest },
    };
    expect(() => ProjectDefinitionSchema.parse(legacy)).toThrow();
    expect(legacyProjectFields(legacy)).toEqual([
      "schemaVersion",
      "controlPlaneUrl",
      "auth",
      "environment",
    ]);
    expect(legacyProjectFields(projectDefinition())).toEqual([]);

    // A definition registered before the removal still loads, without those fields.
    const stored = StoredProjectDefinitionSchema.parse(legacy);
    expect(stored).toEqual(projectDefinition());
  });

  it("StoredProjectDefinitionSchema passes through a connector of an unknown type and keeps a github connector validated; registration still refuses it", () => {
    const withLinear = {
      ...projectDefinition(),
      integrations: {
        connectors: [
          { name: "gh", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
          { name: "tracker", type: "future-vendor", credentialRef: "future-vendor-key", scopes: ["payments"] },
        ],
      },
    };
    const stored = StoredProjectDefinitionSchema.parse(withLinear);
    expect(stored.integrations?.connectors).toEqual(withLinear.integrations.connectors);
    expect(() => ProjectDefinitionSchema.parse(withLinear)).toThrow();

    // A malformed github connector still fails; it never passes through as an unknown type.
    const malformedGithub = {
      ...projectDefinition(),
      integrations: {
        connectors: [
          { name: "gh", type: "github", scopes: 5, tools: [{ name: "list_issues", access: "read" }] },
        ],
      },
    };
    expect(() => StoredProjectDefinitionSchema.parse(malformedGithub)).toThrow();
  });

  it("drops the environment pin from a workspace record written before it was removed", () => {
    const now = new Date().toISOString();
    const workspace = WorkspaceInstanceSchema.parse({
      deploymentMode: "ec2-ebs" as const,
      id: crypto.randomUUID(),
      ownerKey: "a".repeat(64),
      projectName: "payments",
      projectRevision: 1,
      environmentDigest: digest,
      rootPath: "/mnt/workspace",
      status: "READY",
      fence: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(workspace).not.toHaveProperty("environmentDigest");
    expect(workspace.projectRevision).toBe(1);
  });

  it("accepts optional CodeBuild gates and rejects unsafe or duplicate projects", () => {
    const project = projectDefinition();
    project.repositories[0] = {
      ...project.repositories[0]!,
      codeBuildGates: [
        { name: "quality", projectName: "rovara-cloud-payments-quality", timeoutMinutes: 30 },
        { name: "browser", projectName: "rovara-cloud-payments-browser", timeoutMinutes: 45 },
      ],
    } as typeof project.repositories[number];
    expect(ProjectDefinitionSchema.parse(project).repositories[0]!.codeBuildGates).toHaveLength(2);

    const duplicate = structuredClone(project) as unknown as Record<string, unknown>;
    const repositories = duplicate.repositories as Array<Record<string, unknown>>;
    const gates = repositories[0]!.codeBuildGates as Array<Record<string, unknown>>;
    gates[1]!.projectName = gates[0]!.projectName;
    expect(() => ProjectDefinitionSchema.parse(duplicate)).toThrow(/unique/i);

    const unsafe = structuredClone(project) as unknown as Record<string, unknown>;
    const unsafeRepositories = unsafe.repositories as Array<Record<string, unknown>>;
    const unsafeGates = unsafeRepositories[0]!.codeBuildGates as Array<Record<string, unknown>>;
    unsafeGates[0]!.projectName = "unmanaged-project";
    expect(() => ProjectDefinitionSchema.parse(unsafe)).toThrow(/rovara-cloud-/i);
  });

  it("requires a safe default branch and rejects the retired initialCommit field", () => {
    const invalidBranch = projectDefinition();
    invalidBranch.repositories[0]!.defaultBranch = "../main";
    expect(() => ProjectDefinitionSchema.parse(invalidBranch)).toThrow(/defaultBranch/);

    const retired = projectDefinition() as ReturnType<typeof projectDefinition> & {
      repositories: Array<ReturnType<typeof projectDefinition>["repositories"][number] & {
        initialCommit?: string;
      }>;
    };
    retired.repositories[0]!.initialCommit = "b".repeat(40);
    expect(() => ProjectDefinitionSchema.parse(retired)).toThrow();
  });

  it("rejects secrets, routing IDs and overlapping repository paths", () => {
    expect(() =>
      ProjectDefinitionSchema.parse({ ...projectDefinition(), runtimeSessionId: "attacker" }),
    ).toThrow();

    const project = projectDefinition();
    const repository = project.repositories[0]!;
    const nestedRepository = {
      ...repository,
      name: "nested",
      path: "services/api/nested",
    };
    expect(() => ProjectDefinitionSchema.parse({ ...project, repositories: [...project.repositories, nestedRepository] })).toThrow(/overlap/);
  });

  it("rejects unsupported states and unknown workspace keys", () => {
    expect(() =>
      WorkspaceInstanceSchema.parse({
        deploymentMode: "ec2-ebs" as const,
        id: crypto.randomUUID(),
        ownerKey: "owner",
        projectName: "payments",
        projectRevision: 1,
        environmentDigest: digest,
        rootPath: "/mnt/workspace",
        status: "MAGIC",
        activeOperationId: null,
        fence: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps EC2 workspace routing in the session record and reads the removed environment pin", () => {
    const workspace = {
      id: crypto.randomUUID(), ownerKey: "a".repeat(64), projectName: "payments", projectRevision: 1,
      deploymentMode: "ec2-ebs" as const, rootPath: "/mnt/workspace", status: "READY", fence: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), environmentDigest: digest,
    };
    const parsed = WorkspaceInstanceSchema.parse(workspace);
    expect(parsed).toHaveProperty("activeOperationId", null);
    expect(parsed).not.toHaveProperty("environmentDigest");
    expect(parsed).not.toHaveProperty("runtimeArn");
    expect(() => WorkspaceInstanceSchema.parse({ ...workspace, endpointQualifier: "DEFAULT" })).toThrow(/must not have/);
  });

  it("limits prompts by UTF-8 bytes and rejects unknown operation fields", () => {
    const base = {
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      prompt: "change the fixture",
    };
    expect(OperationRequestSchema.parse(base)).toEqual(base);
    expect(() => OperationRequestSchema.parse({ ...base, prompt: "🧑‍💻".repeat(20_000) })).toThrow(
      /65536 UTF-8 bytes/,
    );
    expect(() => OperationRequestSchema.parse({ ...base, ownerKey: "alice" })).toThrow();
  });
});
