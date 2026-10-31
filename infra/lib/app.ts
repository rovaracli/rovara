import { readFileSync } from "node:fs";
import { App, Aspects, LegacyStackSynthesizer, Stack, Tags } from "aws-cdk-lib";
import type { IReusableStackSynthesizer } from "aws-cdk-lib";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { AccessStack } from "./access.js";
import { ControlPlaneStack } from "./control-plane.js";
import { IdentityStack } from "./identity.js";
import { INSTALLER_DESCRIPTION, InstallerStack } from "./installer.js";
import { namingFromContext } from "./naming.js";
import { applyPermissionsBoundaryParameter } from "./permissions-boundary.js";
import { AGENTX_PRODUCTION_VPC_CIDR, ProductionFoundationStack } from "./production-foundation.js";
import { ENTERPRISE_ALLOW_PUBLIC_RANGES_CONTEXT_KEY, ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY, ENTERPRISE_INTERNET_EGRESS_CONTEXT_KEY, parseEditionContext, parseEnterpriseEgressCidrs, parseInternetEgress } from "./vpc-endpoints.js";
import { EDITION_CONTEXT_KEY, NEW_INSTALL_CONTEXT_KEY, editionAtSynth } from "@agentx/contracts";
import { EditionEnvironment } from "./edition-env.js";
import { parsePrivateMcpContext, privateMcpBrokerEnvironment } from "./private-mcp.js";
import { requireEnterpriseAuditTsa } from "./audit-settings.js";
import { ReleasePipelineStack } from "./release-pipeline.js";
import { RetainExceptOnCreate } from "./retention.js";
import { EnvironmentRolePath } from "./role-path.js";
import { SlackOrchestratorStack } from "./slack-orchestrator.js";
import { SwebenchEvalStack, swebenchNames } from "./swebench-eval.js";
import { WorkerSettingsStack } from "./worker-settings.js";

export function buildAgentXApp(context: Record<string, unknown> = {}): App {
  // The default stack synthesizer (and the assembly output directory, below) are
  // App-construction-time settings (Stack cannot pick them up afterwards), so they must be decided
  // before `new App(...)`, from the same context sources CDK itself would merge for every other
  // context key: CDK_CONTEXT_JSON and the context-overflow temp file (how the `cdk` CLI passes `-c`
  // flags and cdk.json to the app it shells out to, since bin/agentx.ts calls buildAgentXApp() with
  // no arguments — the overflow file is used instead of the environment variable when the context
  // is too large for one) and this function's own context argument. App.loadContext treats the
  // constructor's `context` prop as defaults, then layers `{...environment, ...tempFile}` on top of
  // it (the overflow file winning over the environment variable for any key both set), so these
  // pre-App guard clauses must use the same precedence to validate the values the App actually goes
  // on to use. Letting the argument win instead, as before, meant the guard could accept a value
  // that CDK_CONTEXT_JSON/the overflow file would then silently override once the App applied its
  // own precedence — a mismatch between what was validated and what was actually built.
  let cliContext: Record<string, unknown>;
  try {
    cliContext = JSON.parse(process.env[CONTEXT_ENV] ?? "{}") as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${CONTEXT_ENV} environment variable is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const overflowLocation = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
  let overflowContext: Record<string, unknown> = {};
  // Matches CDK App's own readContextFromTempFile: `location ? fs().readJSONSync(location) : {}`.
  // An empty (but set) environment variable must be ignored the same way App ignores it, not
  // treated as a path to read.
  if (overflowLocation) {
    try {
      overflowContext = JSON.parse(readFileSync(overflowLocation, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `${CONTEXT_OVERFLOW_LOCATION_ENV} (${JSON.stringify(overflowLocation)}) could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const mergedContext = { ...context, ...cliContext, ...overflowContext };
  const synthesizerMode = mergedContext.agentxSynthesizer as string | undefined;
  if (synthesizerMode !== undefined && synthesizerMode !== "legacy") {
    throw new Error(`unsupported agentxSynthesizer ${JSON.stringify(synthesizerMode)}; expected legacy or unset`);
  }
  // The legacy synthesizer (no CDK bootstrap, assets as template parameters) is only for a named
  // environment: the deployment that predates environments keeps CDK bootstrap.
  if (synthesizerMode === "legacy" && mergedContext.agentxEnv === undefined) {
    throw new Error("agentxSynthesizer=legacy requires a named environment (agentxEnv context); the deployment that predates environments keeps CDK bootstrap");
  }
  // Lets a caller (the release builder) pin the cloud assembly to a directory it controls and
  // cleans up, instead of the auto-generated temporary directory App falls back to when this is
  // unset (unchanged default behavior).
  const outdir = mergedContext.outdir as string | undefined;
  const app = new App({
    context: { "@aws-cdk/core:defaultCrossStackReferences": "strong", ...context },
    ...(outdir === undefined ? {} : { outdir }),
    // aws-cdk-lib types IStackSynthesizer.bootstrapQualifier as `string | undefined` via a getter,
    // which exactOptionalPropertyTypes rejects for the optional `bootstrapQualifier?: string` on
    // IReusableStackSynthesizer (same shape as the artifactBucket cast in release-pipeline.ts).
    ...(synthesizerMode === "legacy" ? { defaultStackSynthesizer: new LegacyStackSynthesizer() as IReusableStackSynthesizer } : {}),
  });
  const naming = namingFromContext(app);
  const deploymentRegion = app.node.tryGetContext("agentxRegion") as string | undefined;
  const deploymentMode =
    (app.node.tryGetContext("agentxDeploymentMode") as string | undefined) ?? "ec2-ebs";
  if (deploymentMode !== "ec2-ebs") {
    throw new Error(`unsupported agentxDeploymentMode ${deploymentMode}; only ec2-ebs is supported`);
  }
  const identityMode = app.node.tryGetContext("agentxIdentity") as string | undefined;
  if (identityMode !== undefined && identityMode !== "cognito" && identityMode !== "oidc") {
    throw new Error(`unsupported agentxIdentity ${JSON.stringify(identityMode)}; expected cognito, oidc, or unset`);
  }
  // The legacy deployment (no agentxEnv context) predates the identity stack and brings its own
  // OIDC provider by fixed configuration, not by this context value; agentxIdentity has no meaning
  // for it.
  if (naming.env === undefined && identityMode !== undefined) {
    throw new Error(
      `agentxIdentity=${JSON.stringify(identityMode)} is not supported without an agentxEnv context; the legacy deployment has no identity stack`,
    );
  }

  // Lambda reserved concurrency (-c agentxReservedConcurrency=false turns it off). On by default; an account whose Lambda
  // concurrency limit is Lambda's minimum (10, the default for a new account) cannot reserve any, because the unreserved pool
  // may not fall below 10. Production keeps it on. Any value other than true or false is refused, never read as "on".
  const reservedConcurrencyContext: unknown = app.node.tryGetContext("agentxReservedConcurrency");
  if (reservedConcurrencyContext !== undefined && reservedConcurrencyContext !== true && reservedConcurrencyContext !== false && reservedConcurrencyContext !== "true" && reservedConcurrencyContext !== "false") {
    throw new Error(`unsupported agentxReservedConcurrency ${JSON.stringify(reservedConcurrencyContext)}; expected true, false, or unset`);
  }
  const reservedConcurrency = reservedConcurrencyContext !== false && reservedConcurrencyContext !== "false";

  // The hosted Rovara cloud (-c agentxCloud=true): a self-serve Cognito sign-in in the control plane. Named
  // environments only; the legacy deployment is unchanged whatever this says (ruling R12).
  const agentxCloud = naming.env !== undefined && (app.node.tryGetContext("agentxCloud") === true || app.node.tryGetContext("agentxCloud") === "true");

  // The edition of this install (-c rovaraEdition=enterprise|public). Unset keeps today's network. Only the foundation reads it here: the control plane reads it in task E2.
  const explicitEdition = parseEditionContext(app.node.tryGetContext(EDITION_CONTEXT_KEY));
  // Decided once, here (review I-3): Enterprise with the hosted cloud, and Public without it, are refused. Every function and task then carries the result.
  const edition = explicitEdition;
  // `rovaraNewInstall=true` is set by `rovara init`: a new install must choose its edition. An existing install with no explicit edition is not stamped (and never Enterprise).
  const newInstallContext = app.node.tryGetContext(NEW_INSTALL_CONTEXT_KEY) as unknown;
  const decidedEdition = editionAtSynth({ explicit: explicitEdition, cloud: agentxCloud, newInstall: newInstallContext === true || newInstallContext === "true" });
  if (decidedEdition !== undefined) Aspects.of(app).add(new EditionEnvironment(decidedEdition));
  if (decidedEdition === "enterprise" && explicitEdition === "enterprise") {
    // An Enterprise install never leaves the audit anchor on the two public timestamp authorities: the customer names its own or switches it off.
    requireEnterpriseAuditTsa(app.node.tryGetContext("agentxAuditTsa"));
  }
  const isTrue = (value: unknown): boolean => value === true || value === "true";
  const enterpriseInternetEgressContext = app.node.tryGetContext(ENTERPRISE_INTERNET_EGRESS_CONTEXT_KEY) as unknown;
  const enterpriseEgressCidrsContext = app.node.tryGetContext(ENTERPRISE_EGRESS_CIDRS_CONTEXT_KEY) as unknown;
  const enterpriseCidrs = parseEnterpriseEgressCidrs(enterpriseEgressCidrsContext, { allowPublicRanges: isTrue(app.node.tryGetContext(ENTERPRISE_ALLOW_PUBLIC_RANGES_CONTEXT_KEY)) });
  // The access stack holds the roles every other environment stack is deployed with, so it comes
  // first. The deployment that predates environments has none.
  let accessStack: AccessStack | undefined;
  if (naming.env !== undefined) {
    const region = deploymentRegion ?? "us-east-1";
    // Rovara's own AWS Organization id (-c agentxRovaraOrgId=o-...): the default boundary's AssumeOrgRoles statement excludes every account of it, not only this one.
    // Unset or empty keeps the account-only exclusion. Checked when the statement is built.
    const rovaraOrgContext = app.node.tryGetContext("agentxRovaraOrgId") as unknown;
    if (rovaraOrgContext !== undefined && typeof rovaraOrgContext !== "string") throw new Error("agentxRovaraOrgId must be a string, an AWS Organizations id such as o-abc123def4");
    const rovaraOrganizationId = rovaraOrgContext === undefined || rovaraOrgContext === "" ? undefined : rovaraOrgContext;
    accessStack = new AccessStack(app, "AgentXAccess", {
      description: "AgentX access for a named environment: artifact bucket, image cache rule, deploy and operator roles",
      stackName: naming.stackName("access"),
      naming,
      ...(rovaraOrganizationId === undefined ? {} : { rovaraOrganizationId }),
      terminationProtection: true,
      env: { region },
    });
  }
  // The private MCP settings (rovaraPrivateMcpCidrs and the MCP host's certificate): Enterprise only, checked here so a wrong one stops synth, and given to the broker as its environment.
  const privateMcp = parsePrivateMcpContext({ edition: explicitEdition, get: (key) => app.node.tryGetContext(key) as unknown });
  new ControlPlaneStack(app, "AgentXControlPlane", {
    description: "AgentX authenticated control plane and durable dispatch foundation",
    naming,
    ...(Object.keys(privateMcpBrokerEnvironment(privateMcp)).length === 0 ? {} : { brokerEnvironment: privateMcpBrokerEnvironment(privateMcp) }),
    ...(reservedConcurrency ? {} : { reservedConcurrency: false }),
    ...(agentxCloud ? { cloud: true } : {}),
    ...(explicitEdition === "enterprise" ? { privateEgressCidrs: [AGENTX_PRODUCTION_VPC_CIDR, ...enterpriseCidrs] } : {}),
    ...(deploymentRegion === undefined ? {} : { deploymentRegion }),
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("control-plane") }),
  });
  new ProductionFoundationStack(app, "AgentXProductionFoundation", {
    description: "Stable AgentX production network, encryption, and persistent workspace capacity",
    deploymentRegion: deploymentRegion ?? "us-east-1",
    env: { region: deploymentRegion ?? "us-east-1" },
    terminationProtection: true,
    naming,
    ...(agentxCloud ? { cloud: true } : {}),
    ...(edition === undefined ? {} : { edition }),
    ...(parseInternetEgress(enterpriseInternetEgressContext) === undefined ? {} : { internetEgress: parseInternetEgress(enterpriseInternetEgressContext)! }),
    ...(enterpriseEgressCidrsContext === undefined ? {} : { enterpriseEgressCidrs: enterpriseCidrs }),
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("foundation") }),
  });
  // The identity stack is new with named environments; the legacy deployment brings its own OIDC
  // provider instead. Skip it entirely when the environment opts out with agentxIdentity=oidc.
  if (naming.env !== undefined && identityMode !== "oidc") {
    new IdentityStack(app, "AgentXIdentity", {
      description: "AgentX Cognito user pool, admin group and CLI app client for a named environment",
      stackName: naming.stackName("identity"),
      terminationProtection: true,
      naming,
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // The runtime stack holds EC2 worker settings.
  new WorkerSettingsStack(app, "AgentXProductionRuntime", {
    description: "AgentX worker image and model settings for EC2 workers",
    env: { region: deploymentRegion ?? "us-east-1" },
    terminationProtection: true,
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("runtime") }),
  });
  // The release pipeline builds and deploys the live production stacks by their fixed legacy
  // names; it has no meaning for a named environment.
  if (naming.env === undefined) {
    new ReleasePipelineStack(app, "AgentXReleasePipeline", {
      description: "AgentX production release pipeline for the mainline branch",
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  new SlackOrchestratorStack(app, "AgentXSlackOrchestrator", {
    description: "Hosted AgentX Slack orchestrator on ECS Fargate",
    env: { region: deploymentRegion ?? "us-east-1" },
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("slack") }),
    ...(explicitEdition === "enterprise" ? { privateEgressCidrs: [AGENTX_PRODUCTION_VPC_CIDR, ...enterpriseCidrs] } : {}),
  });
  // The Launch in AWS installer, only when asked for (-c agentxInstaller=enabled); no release
  // deploys it, and the environment it installs is never part of it.
  if (app.node.tryGetContext("agentxInstaller") === "enabled") {
    new InstallerStack(app, "AgentXInstaller", {
      description: INSTALLER_DESCRIPTION,
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // Spec 043: the SWE-bench eval stack, only when asked for; no release deploys it.
  if (app.node.tryGetContext("agentxEval") === "enabled") {
    new SwebenchEvalStack(app, "AgentXEval", {
      description: "AgentX SWE-bench eval runs: x86 launch template, runner role, state machine and settings",
      env: { region: deploymentRegion ?? "us-east-1" },
      naming,
      stackName: swebenchNames(naming).stackName,
    });
  }
  if (naming.env !== undefined) {
    Tags.of(app).add("agentx:env", naming.env);
    // Every environment role goes under /agentx/<env>/, the path the CloudFormation service role is
    // scoped to; the access stack's own roles are what that scoping protects, so they stay at root.
    Aspects.of(app).add(new EnvironmentRolePath(naming.env, new Set(accessStack === undefined ? [] : [accessStack])));
    // A failed first create cleans up after itself, so a retry never trips over a kept fixed name.
    Aspects.of(app).add(new RetainExceptOnCreate());
    // Every environment stack gets its own permission boundary parameter, condition, and aspect (the
    // given boundary, else the access stack's default boundary). The access stack already called
    // this itself (it creates the default boundary and needs the effective boundary for its roles'
    // policy statements), so this is a no-op for it.
    for (const stack of app.node.children.filter((c): c is Stack => Stack.isStack(c))) {
      applyPermissionsBoundaryParameter(stack, naming.env);
    }
  }
  return app;
}
