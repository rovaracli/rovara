// The `rovara sso` command group (Enterprise foundations I-5).
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import type { AuditRuntime } from "@agentx/broker/audit/outbox";
import { cloudFormationOutputsReader } from "../deploy/commands.js";
import { stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { TextWriter } from "../init/prompts.js";
import { formatSuccess } from "../output.js";
import { runSsoBootstrap, type SsoBootstrapServices } from "./bootstrap.js";

export interface SsoCommandContext {
  /** Test overrides: never touch AWS. */
  overrides?: Partial<SsoBootstrapServices>;
  parameterStore: (region?: string) => ParameterStore;
  stdout: TextWriter;
  stderr: TextWriter;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function registerSsoCommands(program: Command, context: SsoCommandContext): void {
  const sso = program.command("sso").description("company group sign-in of an Enterprise install");
  sso
    .command("bootstrap")
    .description("first run, once: make the named people owners and write the first group mapping and emergency sign-in list (run with the install's deploy or operator credentials)")
    .option("--claim <name>", "the token claim that carries groups", "groups")
    .option("--admin-group <group>", "a group that administers Rovara (repeat; at least one)", collect, [])
    .option("--member-group <group>", "a group that may use Rovara (repeat)", collect, [])
    .option("--owner-subject <sub>", "the identity provider's subject (sub) of an owner (one or two)", collect, [])
    .option("--break-glass-days <days>", "how long the emergency list lasts (1 to 90)", "30")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .option("--yes", "write it (without this the command only shows the plan)", false)
    .action(async (options: { claim: string; adminGroup: string[]; memberGroup: string[]; ownerSubject: string[]; breakGlassDays: string; region?: string; yes: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean }>();
      const config = options.region === undefined ? {} : { region: options.region };
      const overrides = context.overrides ?? {};
      const documentClient = overrides.documentClient ?? DynamoDBDocumentClient.from(new DynamoDBClient(config), { marshallOptions: { removeUndefinedValues: true } });
      const services: SsoBootstrapServices = {
        store: overrides.store ?? context.parameterStore(options.region),
        identity: overrides.identity ?? stsCallerIdentity(new STSClient(config)),
        outputs: overrides.outputs ?? cloudFormationOutputsReader(new CloudFormationClient(config)),
        documentClient,
        audit: overrides.audit ?? ((tableName): AuditRuntime => ({
          // The ledger's queue is not reachable from here: events are written as pending items in the state table and the install's audit drain delivers them.
          sqs: { send: () => Promise.reject(new Error("no audit queue from the CLI")) } as never,
          queueUrl: "pending-only",
          documentClient: documentClient as never,
          tableName,
          now: Date.now,
          log: () => undefined,
        })),
        write: overrides.write ?? ((line) => { context.stderr.write(`${line}\n`); }),
        now: overrides.now ?? Date.now,
      };
      const result = await runSsoBootstrap(services, globals.env, {
        claim: options.claim, adminGroups: options.adminGroup, memberGroups: options.memberGroup, ownerSubjects: options.ownerSubject, breakGlassDays: Number(options.breakGlassDays),
      }, options.yes);
      context.stdout.write(globals.json ? formatSuccess(result, true) : `Company sign-in is set up for ${result.env}: ${String(result.ownerIds.length)} owner(s), ${String(result.rules)} group rule(s); the emergency list lasts until ${result.breakGlassUntil}.\n`);
    });
}
