import { type E2E_QUALIFICATION_PROFILE_ID, type Ec2RuntimeBinding, ec2WorkerUserData, type QualificationRunInstancesInput, REQUALIFY_TAGS } from "@rovara-code/contracts";

export interface QualificationSettings {
  workerImage: string;
  /** The SHA-256 of the stage 2 boot script the worker image carries (Task 10); boot.sh refuses a worker whose image holds another. */
  bootStage2Sha256?: string | undefined;
  /** Required to qualify, though optional in the worker settings: the web/API runtime needs it. */
  executorImage?: string | undefined;
  modelProvider: string;
  modelId: string;
  promptCacheRetention: "short" | "long";
  openRouterSecretArn?: string | undefined;
  openRouterProviders?: string | undefined;
  anthropicSecretArn?: string | undefined;
  openaiSecretArn?: string | undefined;
}

/** What is read from the live stack: nothing about the TEST installation is written into code. */
export interface QualificationFacts {
  region: string;
  artifactBucket: string;
  controlPlaneUrl: string;
  invokePublicKey: string;
  logGroupName: string;
  launchTemplateId: string;
  /** The unique ID (AROA...) of the worker instance role: the first half of the instance's `${aws:userid}`, which scopes its grant. */
  workerRoleId: string;
  /** The binding `agentx project add` registers for this foundation: every worker subnet. The challenge, and so the registered rows, carry it. */
  binding: Ec2RuntimeBinding;
  /** The one subnet of the binding the worker is launched into. */
  subnet: { availabilityZone: string; subnetId: string };
  volumeSizeGiB: number;
  settings: QualificationSettings;
}

/** The worker's boot configuration for the qualification instance, rendered by the product's own user data helper. */
export function renderQualificationUserData(
  facts: QualificationFacts,
  run: { workspaceId: string; volumeId: string; generation: number; qualification: { profile: typeof E2E_QUALIFICATION_PROFILE_ID } },
  bootScript: string,
): string {
  const { settings } = facts;
  if (settings.executorImage === undefined) {
    throw new Error("the worker settings have no executor image, which the web/API runtime needs; deploy it first (test-deploy --only executor-image)");
  }
  if (settings.bootStage2Sha256 === undefined) {
    throw new Error("the worker settings have no boot stage 2 hash (SSM worker-boot-stage2-sha256), which the worker's boot checks its image against; deploy the worker image with its hash first");
  }
  return ec2WorkerUserData({
    workspaceId: run.workspaceId,
    // The runner compares what it was booted with to its challenge (workspace id = transport correlation, generation): the caller passes the very values the challenge will carry.
    generation: run.generation,
    volumeId: run.volumeId,
    expectNewVolume: true,
    workerImage: settings.workerImage,
    bootStage2Sha256: settings.bootStage2Sha256,
    executorImage: settings.executorImage,
    invokePublicKey: facts.invokePublicKey,
    controlPlaneUrl: facts.controlPlaneUrl,
    modelProvider: settings.modelProvider,
    modelId: settings.modelId,
    promptCacheRetention: settings.promptCacheRetention,
    ...(settings.openRouterSecretArn ? { openRouterSecretArn: settings.openRouterSecretArn } : {}),
    ...(settings.openRouterProviders ? { openRouterProviders: settings.openRouterProviders } : {}),
    ...(settings.anthropicSecretArn ? { anthropicSecretArn: settings.anthropicSecretArn } : {}),
    ...(settings.openaiSecretArn ? { openaiSecretArn: settings.openaiSecretArn } : {}),
    logGroupName: facts.logGroupName,
    e2eQualification: { bucket: facts.artifactBucket, roleId: facts.workerRoleId, profile: run.qualification.profile },
  }, bootScript);
}

/** One instance from the environment's own launch template: its instance type, profile and security group stay the template's. */
export function buildRunInstancesInput(
  facts: QualificationFacts,
  run: { env: string; runId: string; revision: string; userData: string; imageId?: string | undefined },
): QualificationRunInstancesInput {
  return {
    ClientToken: run.runId,
    MinCount: 1,
    MaxCount: 1,
    ...(run.imageId === undefined ? {} : { ImageId: run.imageId }),
    LaunchTemplate: { LaunchTemplateId: facts.launchTemplateId, Version: "$Default" },
    SubnetId: facts.subnet.subnetId,
    UserData: run.userData,
    TagSpecifications: [{
      ResourceType: "instance",
      Tags: [
        { Key: "Application", Value: "AgentX" },
        // Not the launch template's ec2-ebs: the session reconciler ends an ec2-ebs instance of this environment that no session owns once it is
        // 15 minutes old, which would end this one mid-qualification. The request's tags override the template's for the same key.
        { Key: REQUALIFY_TAGS.deploymentModeKey, Value: REQUALIFY_TAGS.deploymentModeValue },
        { Key: REQUALIFY_TAGS.environmentKey, Value: run.env },
        { Key: "Name", Value: `agentx-${run.env}-web-api-qualification-${run.runId.slice(0, 8)}` },
        { Key: "agentx:env", Value: run.env },
        { Key: "agentx:run", Value: run.runId },
        { Key: REQUALIFY_TAGS.runKey, Value: run.runId },
        // The renewal may retire only what carries this tag; the script's runner carries it too, so the next renewal can replace it.
        { Key: REQUALIFY_TAGS.managedKey, Value: REQUALIFY_TAGS.managedValue },
        { Key: "agentx:revision", Value: run.revision },
        { Key: "agentx:runtime-purpose", Value: "web-api-qualification" },
      ],
    }],
  };
}
