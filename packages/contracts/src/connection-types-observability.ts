// Plan 4 Task 11: the six connection types that watch a company's systems (Sentry, Datadog, CloudWatch, Grafana, Vercel and PagerDuty),
// added to Plan 3's org connections (ruling R62). In this plan they are read-only: `access` can only be `read`. Each type's secret is
// write-only like Plan 3's (a record never holds it), and CloudWatch has none: Rovara assumes the customer's role with an external id
// that Rovara sets. Each type's `check` comes from its own connector task.
import { z } from "zod";
import { ConnectionIdSchema } from "./agent.js";
import { ConnectionLabelSchema, ConnectionSecretText } from "./connection-fields.js";
import { publicHttpsUrlSchema } from "./mcp-connector.js";
import type { OrgId } from "./org.js";

export const ObservabilityConnectionTypeSchema = z.enum(["sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"]);
export type ObservabilityConnectionType = z.infer<typeof ObservabilityConnectionTypeSchema>;

/** The text of the refusal when one of these connections is asked to be more than read-only. */
export const readOnlyConnectionMessage = (type: ObservabilityConnectionType): string => `access: ${type} connections are read-only`;

/** `read` is the only access these types have in this plan. */
const readOnly = (type: ObservabilityConnectionType) => z.literal("read", { error: readOnlyConnectionMessage(type) });

const Common = (type: ObservabilityConnectionType) => ({ connectionId: ConnectionIdSchema, label: ConnectionLabelSchema, access: readOnly(type) }) as const;

export const SentryRegionSchema = z.enum(["us", "de"]);
export const SentryOrgSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/);

export const DATADOG_SITES = ["datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com", "us2.ddog-gov.com", "uk1.datadoghq.com"] as const;
export const DatadogSiteSchema = z.enum(DATADOG_SITES);

/** An IAM role in any AWS partition (`aws`, `aws-cn`, `aws-us-gov`, ...): the role Rovara assumes in the customer's account. */
export const CloudWatchRoleArnSchema = z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/);
/**
 * Every AWS region code (docs.aws.amazon.com/general/latest/gr/rande.html, 2026-10-22), with the two China regions and the two GovCloud regions. A region
 * outside it is refused when a connection or a connector scope is saved. A region AWS adds later is added here.
 */
export const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "af-south-1",
  "ap-east-1", "ap-east-2", "ap-south-1", "ap-south-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5", "ap-southeast-6", "ap-southeast-7",
  "ca-central-1", "ca-west-1",
  "eu-central-1", "eu-central-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2",
  "il-central-1", "me-central-1", "me-south-1", "mx-central-1", "sa-east-1",
  "cn-north-1", "cn-northwest-1", "us-gov-east-1", "us-gov-west-1",
] as const;
/** An AWS region code such as `us-east-1`, from `AWS_REGIONS`. */
export const AwsRegionSchema = z.enum(AWS_REGIONS);

/** The 12-digit AWS account a CloudWatch role ARN names, or undefined when it is not a role ARN. */
export const cloudwatchRoleAccount = (roleArn: string): string | undefined => /^arn:aws[a-z-]*:iam::(\d{12}):role\//u.exec(roleArn)?.[1];
export const CLOUDWATCH_MAX_REGIONS = 5;

export const VercelTeamIdSchema = z.string().regex(/^team_[A-Za-z0-9]{1,64}$/);
export const PagerDutyRegionSchema = z.enum(["us", "eu"]);

/** The external id Rovara sends when it assumes a CloudWatch connection's role: set by the server from the org, never taken from a body. */
export const cloudwatchExternalId = (orgId: OrgId): string => `rovara-${orgId}`;

export const ObservabilityConnectionSchemas = [
  z.object({ ...Common("sentry"), type: z.literal("sentry"), region: SentryRegionSchema, orgSlug: SentryOrgSlugSchema }).strict(),
  z.object({ ...Common("datadog"), type: z.literal("datadog"), site: DatadogSiteSchema }).strict(),
  z.object({
    ...Common("cloudwatch"), type: z.literal("cloudwatch"), roleArn: CloudWatchRoleArnSchema,
    regions: z.array(AwsRegionSchema).min(1).max(CLOUDWATCH_MAX_REGIONS).refine((regions) => new Set(regions).size === regions.length, "must not repeat a region"),
  }).strict(),
  z.object({ ...Common("grafana"), type: z.literal("grafana"), baseUrl: publicHttpsUrlSchema("baseUrl") }).strict(),
  z.object({ ...Common("vercel"), type: z.literal("vercel"), teamId: VercelTeamIdSchema.optional() }).strict(),
  z.object({ ...Common("pagerduty"), type: z.literal("pagerduty"), region: PagerDutyRegionSchema }).strict(),
] as const;

/** What each secret holds. Write-only: nothing returns it. CloudWatch has none. */
export const ObservabilitySecretSchemas = {
  sentry: z.object({ authToken: ConnectionSecretText }).strict(),
  datadog: z.object({ apiKey: ConnectionSecretText, appKey: ConnectionSecretText }).strict(),
  grafana: z.object({ serviceAccountToken: ConnectionSecretText }).strict(),
  vercel: z.object({ token: ConnectionSecretText }).strict(),
  pagerduty: z.object({ apiKey: ConnectionSecretText }).strict(),
} as const;
