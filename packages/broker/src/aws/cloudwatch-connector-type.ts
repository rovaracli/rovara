// Plan 4 Task 16: the CloudWatch connector type, and the deployment's AWS access it reads through. It is not a `nativeConnectorType`: CloudWatch has no token, so
// there is no registry credential to pin to a vendor host. Its credential step assumes the customer's role (`assumeCustomerRole`) with the external id of the org
// the request is for, and the tools run with that session's clients. The connection's settings (role and regions) are read from the org's own registry on every use.
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { AssumeRoleCommand, STSClient, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { CloudWatchConnectorSchema, type OrgConnection, type OrgId } from "@rovara-code/contracts";
import { CredentialUnavailable, type Binder, type ConnectorDefinition, type CredentialProvider, type IssuedCredential, type connectMcp } from "@agentx/gateway";
import { connectorLedgerKeys } from "./connector-ledger.js";
import type { ConnectorType } from "./connector-types.js";
import type { CheckResult, ConnectionCheckInput } from "../connections/store.js";
import {
  CLOUDWATCH_ROUTING_PROPERTIES,
  CLOUDWATCH_TOOLS,
  CloudWatchAccessError,
  assumeCustomerRole,
  checkCloudWatch,
  cloudwatchRoutingValues,
  cloudwatchUnavailableTools,
  packCredentials,
  unpackCredentials,
  type AssumedAwsCredentials,
  type AwsSender,
  type CloudWatchAws,
  type CloudWatchEngineScope,
  type CloudWatchRunScope,
} from "../connectors/native/cloudwatch.js";
import { nativeConnection } from "../connectors/native/runtime.js";

type CloudWatchConnection = Extract<OrgConnection, { type: "cloudwatch" }>;

const NOT_CONFIGURED = "connector credentials are not configured in this deployment";
const NO_AWS = "AWS access is not configured in this deployment";
const NO_ORG = "CloudWatch connectors need an organization";
/** A session is reused until this long before it expires. */
const REUSE_MARGIN_MS = 60_000;
const refusingFetch = () => Promise.reject(new TypeError("a CloudWatch tool makes no web requests"));

type Loaded = { problem: string } | { connection: CloudWatchConnection; aws: CloudWatchAws; orgId: OrgId };

/** Plan 4 Task 16: AWS CloudWatch, read natively in the broker through a role the customer made in their own AWS account; one scope per region. */
export const cloudwatchConnectorType: ConnectorType = {
  type: "cloudwatch",
  resolve(config, _project, context) {
    const parsed = CloudWatchConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      const rules = parsed.error.issues.filter((issue) => issue.code === "custom" && issue.path.length === 0).map((issue) => issue.message);
      return { unusable: [`invalid cloudwatch connector configuration: ${fields.join(", ")}`, ...rules].join("; ").slice(0, 300) };
    }
    const stored = parsed.data;
    const ref = stored.credentialRef;
    const routingNames = Object.keys(CLOUDWATCH_ROUTING_PROPERTIES);
    /** The org's own connection (its settings, read now), the AWS access and the org the request is for, or why the connector cannot be served. */
    const load = async (): Promise<Loaded> => {
      const registry = context.credentialRegistry;
      if (!registry) return { problem: NOT_CONFIGURED };
      if (context.orgId === undefined) return { problem: NO_ORG };
      if (context.cloudwatchAws === undefined) return { problem: NO_AWS };
      const connection = await registry.connection?.(ref);
      if (connection === undefined || connection.type !== "cloudwatch") return { problem: `connection ${ref} is not a CloudWatch connection` };
      return { connection, aws: context.cloudwatchAws, orgId: context.orgId };
    };
    // The session of each role and org, reused while it has time left. Keyed by what decides the session, so an edited role or another org is never served from it.
    const sessions = new Map<string, AssumedAwsCredentials>();
    const connect: typeof connectMcp = async (target) => {
      const aws = context.cloudwatchAws;
      const credentials = unpackCredentials(target.token);
      if (aws === undefined || credentials === undefined) throw new CredentialUnavailable(aws === undefined ? NO_AWS : "the AWS session could not be read; try again");
      const clients = (region: string) => aws.clientsFor(credentials, region);
      return nativeConnection<CloudWatchRunScope>(CLOUDWATCH_TOOLS, target.tools, {
        credential: { token: target.token, bindings: {} },
        fetch: refusingFetch,
        routing: {
          properties: CLOUDWATCH_ROUTING_PROPERTIES,
          scopeOf: (values) => {
            const { monitoring, logs } = clients(values["region"]!);
            return {
              alias: values["scopeAlias"]!, region: values["region"]!,
              logGroupPrefixes: values["logGroupPrefixes"] === "" ? [] : values["logGroupPrefixes"]!.split(","),
              alarmNamePrefix: values["alarmNamePrefix"]!,
              aws: { monitoring, logs, now: () => aws.now(), sleep: (ms) => aws.sleep(ms) },
            };
          },
        },
        // The parts of the session, scrubbed from anything a tool answers.
        scrub: [credentials.sessionToken, credentials.secretAccessKey, credentials.accessKeyId],
      });
    };
    return {
      name: stored.name,
      type: "cloudwatch",
      label: "CloudWatch",
      vendor: "CloudWatch",
      scopeNoun: "region",
      scopes: stored.scopes.map((scope) => ({
        alias: scope.alias,
        scope: { alias: scope.alias, region: scope.region, ...(scope.logGroupPrefixes === undefined ? {} : { logGroupPrefixes: scope.logGroupPrefixes }), ...(scope.alarmNamePrefix === undefined ? {} : { alarmNamePrefix: scope.alarmNamePrefix }) } satisfies CloudWatchEngineScope,
      })),
      policy: { tools: stored.tools },
      approvals: stored.tools,
      // Nothing is written, so there is no requester footer to sign.
      attribution: false,
      ledger: connectorLedgerKeys(stored.name),
      // No `credential`: there is no registry token to check or pin; `load` and `issue` below decide everything.
      configured: async () => !("problem" in await load()),
      async definition() {
        const loaded = await load();
        if ("problem" in loaded) return { notConnected: loaded.problem };
        const credentials: CredentialProvider<CloudWatchEngineScope> = {
          issue: async (scope, access): Promise<IssuedCredential> => {
            if (access !== "read") throw new CredentialUnavailable("CloudWatch connections are read-only");
            // Read again now: a role or a region changed since is felt, and a connection removed is gone.
            const fresh = await load();
            if ("problem" in fresh) throw new CredentialUnavailable(fresh.problem);
            if (!(fresh.connection.regions as readonly string[]).includes(scope.region)) throw new CredentialUnavailable(`this connection is not set up for ${scope.region}; add the region to the connection`);
            const key = `${fresh.orgId}|${fresh.connection.connectionId}|${fresh.connection.roleArn}`;
            let session = sessions.get(key);
            if (session === undefined || session.expiration.getTime() - REUSE_MARGIN_MS <= fresh.aws.now()) {
              try {
                session = await assumeCustomerRole(fresh.aws, { orgId: fresh.orgId, connection: fresh.connection });
              } catch (error) {
                throw new CredentialUnavailable(error instanceof CloudWatchAccessError ? error.message : "AWS could not be reached to assume the role; try again");
              }
              sessions.set(key, session);
            }
            return { token: packCredentials(session), bindings: {} };
          },
          invalidate: async () => { sessions.clear(); },
        };
        const binder: Binder<CloudWatchEngineScope> = {
          properties: routingNames,
          bind: (scope) => cloudwatchRoutingValues(scope),
        };
        const definition: ConnectorDefinition<CloudWatchEngineScope> = {
          label: "CloudWatch",
          endpoint: new URL("https://monitoring.amazonaws.com/"),
          permissionsHint: "the customer's IAM role, its trust policy and its read permissions",
          credentials,
          binder,
          guards: [],
          itemArguments: [],
          unavailableTools: (scope) => cloudwatchUnavailableTools(scope),
        };
        return definition;
      },
      connect,
    };
  },
};

/** The org connection check for a CloudWatch connection (`OrgConnectionStoreInput.checks.cloudwatch`), over the deployment's AWS access. */
export const cloudwatchConnectionCheck = (aws: CloudWatchAws) =>
  async (input: ConnectionCheckInput<"cloudwatch">): Promise<CheckResult> => checkCloudWatch(aws, { orgId: input.orgId, connection: input.connection });

const REQUEST_TIMEOUT_MS = 10_000;

/** An SDK client as an `AwsSender`: the connector sends SDK commands and reads outputs. */
const senderOf = (client: { send(command: never): Promise<unknown> }): AwsSender => ({ send: (command) => client.send(command as never) });

/**
 * The deployment's AWS access: STS with the broker's own identity, and SDK clients that sign with an assumed session. Clients give up quickly (10 seconds, two
 * attempts), so a slow AWS cannot hold a request open. Built once per deployment; no client is made until a role is assumed.
 */
export function awsCloudWatchAccess(input: { ownAccountId: string | undefined; sts: AwsSender; now?: () => number; sleep?: (ms: number) => Promise<void> }): CloudWatchAws {
  return {
    ownAccountId: input.ownAccountId,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })),
    async assumeRole(params) {
      const response = await input.sts.send(new AssumeRoleCommand(params)) as Pick<AssumeRoleCommandOutput, "Credentials">;
      const credentials = response.Credentials;
      if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) {
        throw new CredentialUnavailable("AWS gave no credentials for the role");
      }
      return { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken, expiration: credentials.Expiration };
    },
    clientsFor(credentials, region) {
      const configuration = {
        region,
        credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, expiration: credentials.expiration },
        maxAttempts: 2,
        requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: REQUEST_TIMEOUT_MS },
      };
      return { sts: senderOf(new STSClient(configuration)), monitoring: senderOf(new CloudWatchClient(configuration)), logs: senderOf(new CloudWatchLogsClient(configuration)) };
    },
  };
}
