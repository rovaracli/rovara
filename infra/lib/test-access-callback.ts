// The customer test account's callback topics (lane TA1; customer-test-account.md section 1, "Getting the role ARN back"). When a customer creates the test-access stack, its custom resource publishes the new
// role to Rovara's SNS topic in the stack's Region; Rovara's handler (lane TA2) reads it and answers CloudFormation. A custom resource's ServiceToken must be in the Region of the stack
// (AWS::CloudFormation::CustomResource, ServiceToken), so there is one topic per Region a customer can connect, with the same name in each.
//
// What one Region's stack holds:
//   - the topic, and a topic policy that lets any AWS account publish to it (and only publish, and only over TLS). The customer's account is not known when the topic is made, and CloudFormation publishes with the
//     caller's own credentials, so the policy cannot name the publisher; nothing in an SNS policy can look inside the message. The message is checked by the handler instead: the one-use connect token, and the binding of the stack's
//     account and Region to the role it reports (`parseTestAccessCallback`). A message from anyone else is dropped.
//   - one subscription: the handler, a Lambda function in the home Region, delivered across Regions by SNS. A failed delivery goes to a dead-letter queue (14 days), so a callback is never silently lost.
//   - in the home Region only: the Lambda permission for every topic. (A Lambda permission lives with the function, so the home stack lists every Region's topic ARN, built from the shared name.)
//
// OFF by default and CODE ONLY until the handler exists: `-c agentxTestAccess=enabled` (hosted cloud only: a customer's own install must not publish a topic that takes messages from any account) adds one stack per Region
// (`-c agentxTestAccessRegions=us-east-1,us-west-2,...`; the default is TEST_ACCESS_DEFAULT_REGIONS, and the home Region is always included). No release deploys it, and lane TA1 does not: the subscription needs the handler function
// `<prefix>-test-access-callback-handler` (lane TA2) to exist in the home Region first.
import { Aws, CfnOutput, Duration, Stack, type StackProps, aws_iam as iam, aws_lambda as lambda, aws_sns as sns, aws_sqs as sqs } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { TestAccessRegionSchema, TEST_ACCESS_DEFAULT_REGIONS, snsServicePrincipal, testAccessTopicName } from "@agentx/cloud-contracts";
import type { AgentXNaming } from "./naming.js";

export const TEST_ACCESS_CONTEXT_KEY = "agentxTestAccess";
export const TEST_ACCESS_REGIONS_CONTEXT_KEY = "agentxTestAccessRegions";

/** The handler function (lane TA2 creates it with this name in the home Region). */
export function testAccessHandlerFunctionName(naming: AgentXNaming): string {
  return `${naming.resourcePrefix}-test-access-callback-handler`;
}

export function testAccessStackName(naming: AgentXNaming, region: string): string {
  return naming.env === undefined ? `AgentXTestAccess-${region}` : `agentx-${naming.env}-test-access-${region}`;
}

export interface TestAccessSettings {
  readonly homeRegion: string;
  /** Every Region that gets a topic, the home Region included, sorted. */
  readonly regions: readonly string[];
}

/** Reads the context. Undefined when the switch is off; throws, so the synth stops, on anything that is not exactly what it asks for. */
export function parseTestAccessContext(input: { readonly get: (key: string) => unknown; readonly homeRegion: string; readonly cloud: boolean }): TestAccessSettings | undefined {
  const switchValue = input.get(TEST_ACCESS_CONTEXT_KEY);
  if (switchValue === undefined || switchValue === "disabled") return undefined;
  if (switchValue !== "enabled") throw new Error(`unsupported ${TEST_ACCESS_CONTEXT_KEY} ${JSON.stringify(switchValue)}; expected enabled, disabled, or unset`);
  if (!input.cloud) throw new Error(`${TEST_ACCESS_CONTEXT_KEY}=enabled is for the hosted Rovara cloud (-c agentxCloud=true): a customer's own install must not publish a topic that takes messages from any account`);
  const list = input.get(TEST_ACCESS_REGIONS_CONTEXT_KEY);
  if (list !== undefined && typeof list !== "string") throw new Error(`${TEST_ACCESS_REGIONS_CONTEXT_KEY} is a comma-separated list of Regions`);
  const named = list === undefined || list === "" ? TEST_ACCESS_DEFAULT_REGIONS : list.split(",").map((region) => region.trim());
  const regions = [...new Set([input.homeRegion, ...named])].map((region) => TestAccessRegionSchema.parse(region)).sort();
  return { homeRegion: input.homeRegion, regions };
}

export interface TestAccessCallbackStackProps extends StackProps {
  readonly naming: AgentXNaming;
  readonly settings: TestAccessSettings;
  /** The Region this stack is for: the topic's Region. */
  readonly region: string;
}

export class TestAccessCallbackStack extends Stack {
  readonly topic: sns.Topic;
  readonly deadLetters: sqs.Queue;

  constructor(scope: Construct, id: string, props: TestAccessCallbackStackProps) {
    super(scope, id, { ...props, env: { ...props.env, region: props.region } });
    const { naming, settings, region } = props;
    const topicName = testAccessTopicName(naming.resourcePrefix);
    this.topic = new sns.Topic(this, "Callback", { topicName, displayName: "Rovara test account callback" });
    // The one wildcard principal, as narrow as SNS lets it be: publish only, and only over TLS. A plain-HTTP publish is refused outright.
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: "CustomerStacksPublish",
      effect: iam.Effect.ALLOW,
      principals: [new iam.AnyPrincipal()],
      actions: ["sns:Publish"],
      resources: [this.topic.topicArn],
      conditions: { Bool: { "aws:SecureTransport": "true" } },
    }));
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: "RefusePlainHttp",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["sns:Publish"],
      resources: [this.topic.topicArn],
      conditions: { Bool: { "aws:SecureTransport": "false" } },
    }));
    this.deadLetters = new sqs.Queue(this, "DeadLetters", { encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(14) });
    this.deadLetters.addToResourcePolicy(new iam.PolicyStatement({
      sid: "TopicDeadLetters",
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal(snsServicePrincipal(region))],
      actions: ["sqs:SendMessage"],
      resources: [this.deadLetters.queueArn],
      conditions: { ArnEquals: { "aws:SourceArn": this.topic.topicArn } },
    }));
    const handlerArn = `arn:${Aws.PARTITION}:lambda:${settings.homeRegion}:${Aws.ACCOUNT_ID}:function:${testAccessHandlerFunctionName(naming)}`;
    new sns.CfnSubscription(this, "Handler", {
      topicArn: this.topic.topicArn,
      protocol: "lambda",
      endpoint: handlerArn,
      redrivePolicy: { deadLetterTargetArn: this.deadLetters.queueArn },
    });
    if (region === settings.homeRegion) {
      // The function's side of delivery: every Region's topic may invoke it. The ARNs are built from the shared topic name, so no stack refers to another.
      settings.regions.forEach((topicRegion, index) => {
        new lambda.CfnPermission(this, `Invoke${index}`, {
          action: "lambda:InvokeFunction",
          functionName: handlerArn,
          principal: snsServicePrincipal(topicRegion),
          sourceArn: `arn:${Aws.PARTITION}:sns:${topicRegion}:${Aws.ACCOUNT_ID}:${topicName}`,
          sourceAccount: Aws.ACCOUNT_ID,
        });
      });
    }
    new CfnOutput(this, "TopicArn", { value: this.topic.topicArn, description: "The topic a customer's test-access stack publishes to in this Region" });
  }
}
