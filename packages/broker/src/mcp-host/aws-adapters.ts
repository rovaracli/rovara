// Stdio MCP host redesign (T6): the real AWS clients behind the gateway's narrow interfaces (`EcsApi`, `BundleObjectApi`). The gateway holds the rules; these only translate. Nothing here
// is called in a test against AWS: the tests pass fake SDK classes.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { BundleObjectApi, EcsApi, EcsTaskDescription } from "@agentx/gateway";

/** The part of `@aws-sdk/client-ecs` this uses. The module is loaded by name at start-up (the infrastructure task adds it to the dependencies and the image). */
export interface EcsSdk {
  ECSClient: new (config: Record<string, unknown>) => { send(command: unknown): Promise<EcsResponse> };
  RunTaskCommand: new (input: Record<string, unknown>) => unknown;
  StopTaskCommand: new (input: Record<string, unknown>) => unknown;
  DescribeTasksCommand: new (input: Record<string, unknown>) => unknown;
  ListTasksCommand: new (input: Record<string, unknown>) => unknown;
}

/** The fields of ECS's answers that are read here. */
export interface EcsResponse {
  tasks?: Array<{
    taskArn?: string; lastStatus?: string; startedAt?: Date; createdAt?: Date; tags?: Array<{ key?: string; value?: string }>;
    attachments?: Array<{ type?: string; details?: Array<{ name?: string; value?: string }> }>; containers?: Array<{ name?: string; exitCode?: number }>;
  }>;
  failures?: unknown[];
  taskArns?: string[];
  nextToken?: string;
}

const MAX_LIST_PAGES = 20;

export function ecsApiFromSdk(sdk: EcsSdk, client: InstanceType<EcsSdk["ECSClient"]>): EcsApi {
  return {
    async runTask(input) {
      const out = await client.send(new sdk.RunTaskCommand({ ...input }));
      return { taskArns: (out.tasks ?? []).map((task) => task.taskArn).filter((arn): arn is string => typeof arn === "string"), failureCount: (out.failures ?? []).length };
    },
    async stopTask(input) {
      await client.send(new sdk.StopTaskCommand({ cluster: input.cluster, task: input.taskArn, reason: input.reason.slice(0, 250) }));
    },
    async describeTasks(input) {
      const out = await client.send(new sdk.DescribeTasksCommand({ cluster: input.cluster, tasks: input.taskArns, include: ["TAGS"] }));
      return (out.tasks ?? []).map((task): EcsTaskDescription => {
        const interfaceDetails = (task.attachments ?? []).find((attachment) => attachment.type === "ElasticNetworkInterface")?.details ?? [];
        const exitCodes: Record<string, number | undefined> = {};
        for (const container of task.containers ?? []) if (container.name !== undefined) exitCodes[container.name] = container.exitCode;
        return {
          taskArn: String(task.taskArn), lastStatus: String(task.lastStatus), startedAt: task.startedAt, createdAt: task.createdAt,
          tags: (task.tags ?? []).filter((tag): tag is { key: string; value: string } => typeof tag.key === "string" && typeof tag.value === "string"),
          privateIpv4: interfaceDetails.find((detail) => detail.name === "privateIPv4Address")?.value, exitCodes,
        };
      });
    },
    async listTaskArns(input) {
      const arns: string[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const out = await client.send(new sdk.ListTasksCommand({ cluster: input.cluster, startedBy: input.startedBy, desiredStatus: "RUNNING", ...(nextToken === undefined ? {} : { nextToken }) }));
        arns.push(...(out.taskArns ?? []));
        nextToken = out.nextToken;
        if (nextToken === undefined) return arns;
      }
      // More pages than a controller should ever see: the list is not trusted to be complete, so it is not used to decide what is a leftover.
      throw new Error("too many tasks to list");
    },
  };
}

/** The bundle bucket, through the three S3 calls the store makes. */
export function bundleObjectApiFromS3(client: Pick<S3Client, "send">, bucket: string): BundleObjectApi {
  return {
    async put(input) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: input.body, ContentLength: input.size, ContentType: "application/x-tar" }));
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return out.Body === undefined ? undefined : { size: Number(out.ContentLength ?? 0), stream: out.Body as Readable };
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === "NoSuchKey") return undefined;
        throw error;
      }
    },
    async head(key) {
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "NotFound" || name === "NoSuchKey") return false;
        throw error;
      }
    },
  };
}
