// The Lambda entry of the customer-owned bundle deployer (see deploy.ts). The environment names the install; nothing in the event does.
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
} from "@aws-sdk/client-cloudformation";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { runDeployer, type DeployerPorts } from "./deploy.js";

const cloudFormation = new CloudFormationClient({});
const s3 = new S3Client({});
const ssm = new SSMClient({});
const sns = new SNSClient({});
const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

export function buildPorts(deadlineAt: number): DeployerPorts {
  const bucket = required("APPROVAL_BUCKET");
  return {
    env: required("ROVARA_ENV"),
    region: required("AWS_REGION"),
    bucket,
    urlSuffix: required("URL_SUFFIX"),
    deployRoleArn: required("DEPLOY_ROLE_ARN"),
    now: () => Date.now(),
    deadlineAt,
    s3: {
      async get(key, versionId) {
        try {
          const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(versionId === undefined ? {} : { VersionId: versionId }) }));
          return Buffer.from(await (result.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
        } catch (error) {
          // A deleted object (a delete marker answers "NoSuchKey" or "MethodNotAllowed" for a version) is an absent one.
          if (errorName(error) === "NoSuchKey" || errorName(error) === "NoSuchVersion") return undefined;
          throw error;
        }
      },
      async put(key, body) {
        const result = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
        return { versionId: result.VersionId };
      },
    },
    alert: {
      async publish(message) {
        await sns.send(new PublishCommand({ TopicArn: required("ALERT_TOPIC_ARN"), Subject: "Rovara bundle deployer", Message: message }));
      },
    },
    ssm: {
      async get(name) {
        try {
          return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
        } catch (error) {
          if (errorName(error) === "ParameterNotFound") return undefined;
          throw error;
        }
      },
      async getVersioned(name) {
        try {
          const parameter = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter;
          if (parameter?.Value === undefined) return undefined;
          return { value: parameter.Value, version: parameter.Version ?? 0, modifiedAt: parameter.LastModifiedDate?.getTime() };
        } catch (error) {
          if (errorName(error) === "ParameterNotFound") return undefined;
          throw error;
        }
      },
      async put(name, value, options) {
        await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: "String", Overwrite: options?.createOnly !== true }));
      },
      async delete(name) {
        try {
          await ssm.send(new DeleteParameterCommand({ Name: name }));
        } catch (error) {
          if (errorName(error) !== "ParameterNotFound") throw error;
        }
      },
    },
    cfn: {
      async describe(stackName) {
        try {
          const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
          if (stack === undefined) return undefined;
          return { status: stack.StackStatus ?? "", parameters: Object.fromEntries((stack.Parameters ?? []).flatMap((parameter) => (parameter.ParameterKey === undefined ? [] : [[parameter.ParameterKey, parameter.ParameterValue ?? ""] as const]))) };
        } catch (error) {
          if (error instanceof Error && /does not exist/.test(error.message)) return undefined;
          throw error;
        }
      },
      async getTemplate(stackName) {
        try {
          return (await cloudFormation.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }))).TemplateBody;
        } catch {
          return undefined;
        }
      },
      async deleteChangeSet(stackName, name) {
        try {
          await cloudFormation.send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: name }));
        } catch {
          // None to delete.
        }
      },
      async createChangeSet(input) {
        await cloudFormation.send(new CreateChangeSetCommand({
          StackName: input.stackName,
          ChangeSetName: input.name,
          ChangeSetType: "UPDATE",
          TemplateURL: input.templateUrl,
          RoleARN: input.roleArn,
          Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
          Parameters: input.parameters.map((parameter) => (parameter.usePrevious === true ? { ParameterKey: parameter.key, UsePreviousValue: true } : { ParameterKey: parameter.key, ParameterValue: parameter.value ?? "" })),
        }));
      },
      async waitChangeSet(stackName, name, untilMs) {
        while (Date.now() < untilMs) {
          const described = await cloudFormation.send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: name }));
          if (described.Status === "CREATE_COMPLETE") return "ready";
          if (described.Status === "FAILED") return /didn't contain changes|No updates/i.test(described.StatusReason ?? "") ? "no-changes" : "failed";
          await sleep(3_000);
        }
        return "failed";
      },
      async executeChangeSet(stackName, name) {
        await cloudFormation.send(new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: name }));
      },
      async waitStack(stackName, untilMs) {
        while (Date.now() < untilMs) {
          const status = (await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus ?? "";
          if (status === "UPDATE_COMPLETE" || status === "CREATE_COMPLETE") return "complete";
          if (!status.endsWith("_IN_PROGRESS")) return "failed";
          await sleep(10_000);
        }
        return "timeout";
      },
    },
  };
}

export async function handler(event: unknown, context: { getRemainingTimeInMillis(): number }): Promise<unknown> {
  try {
    return await runDeployer(event, buildPorts(Date.now() + context.getRemainingTimeInMillis() - 30_000));
  } catch (error) {
    // The log gets the error's name only; the caller gets a fixed reason.
    console.error(JSON.stringify({ event: "bundle-deployer-error", name: errorName(error) }));
    return { status: "failed", reason: "an unexpected error stopped the deployment" };
  }
}
