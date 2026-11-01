import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  SLACK_CHAT_ATTRIBUTE, SLACK_NOTE_TS_ATTRIBUTE, SLACK_QUEUED_BEHIND_ATTRIBUTE, SLACK_ROUTE_ATTRIBUTE, SLACK_TASK_ID_ATTRIBUTE, confirmationBlocks,
  SlackRequestMessageSchema, isAskRoute, isPageCommentRoute, queuedBehindOf, routeOf, sharedNoticeClaim, taskQuestionOf, type AskRef, type SlackRequestMessage,
} from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { runOrchestratorTurn } from "@agentx/orchestrator/orchestrator";
import { createDynamoActiveTurnStore } from "./active-turn-store.js";
import { createDynamoConfirmationStore } from "./confirmation-store.js";
import { runConsumer, type QueueClient } from "./consumer.js";
import { processSlackRequest, type ServiceLog, type ThreadServiceApi, type ThreadStore, type TurnInput } from "./processor.js";
import { createProxiedModels } from "./proxied-models.js";
import { createSignedServiceFetch } from "./signing-fetch.js";
import { createSlackUserNames } from "./user-names.js";
import { createAskApi, createEvalBatchWatchApi, createThreadApi } from "./thread-api.js";
import { handleAsk } from "./ask-question.js";
import { SlackApiError, runEvalBatchWatcher } from "./eval-batch-watcher.js";
import { HANDOFF_MILLISECONDS, activeTurnFromItem, turnNoteFromItem } from "./interrupted-turn.js";
import { classifierTimeoutMs, createHostedClassifier, createHostedRequestRouter, createHostedSlackRuntime, gateDecisionLogFields, runHostedTurn } from "./runtime.js";
import { createChoiceOffer, routeSlackRequest } from "./request-routing.js";
import { DynamoTurnRecordWriter } from "./turn-records.js";
import { handlePageComment } from "./page-comment.js";
import { handleTaskQuestion, runTaskAnswer } from "./task-question.js";
import { deterministicUuid, requestIdSequence } from "./ids.js";

const MAX_RECEIVE_COUNT = 5;
const VISIBILITY_SECONDS = 15 * 60;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const region = required("AWS_REGION");
const queueUrl = required("SLACK_REQUEST_QUEUE_URL");
const threadsTableName = required("SLACK_THREADS_TABLE_NAME");
const sessionBucketName = required("THREAD_SESSION_BUCKET_NAME");
const controlPlaneUrl = required("CONTROL_PLANE_URL").replace(/\/$/, "");
const slackSecretArn = required("SLACK_SECRET_ARN");
const turnRecordsTableName = required("TURN_RECORDS_TABLE_NAME");
const stateDirectory = process.env.STATE_DIRECTORY ?? "/tmp/agentx-slack";
const concurrency = Number.parseInt(process.env.SLACK_CONCURRENCY ?? "4", 10);
const model = {
  provider: process.env.AGENTX_ORCHESTRATOR_PROVIDER ?? "amazon-bedrock",
  modelId: process.env.AGENTX_ORCHESTRATOR_MODEL ?? "us.anthropic.claude-sonnet-4-6",
};

// Task 13: with the model proxy's address set, every model call of a turn goes through it with a key the control plane mints
// for that turn, and the service reads no provider secret. Unset, models are reached as they always were.
const modelProxyEnabled = (process.env.AGENTX_MODEL_PROXY_URL ?? "") !== "";

const credentials = defaultProvider();
const sqs = new SQSClient({ region });
const s3 = new S3Client({ region });
const secretsManager = new SecretsManagerClient({ region });
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const log: ServiceLog = (event, fields) => {
  console.log(JSON.stringify({ component: "slack-orchestrator", event, ...fields }));
};

// The action gate's classifier (spec 014): a small model chosen per deployment through the
// AgentXSlackOrchestrator parameter GateClassifierModelId. If it cannot be made, including a model
// the runtime does not know, the service still starts, logs gate.classifier_unavailable and says
// classifierAvailable: false in its start log, and every change no rule settles asks.
const classifierModel = {
  provider: process.env.AGENTX_GATE_CLASSIFIER_PROVIDER ?? "amazon-bedrock",
  modelId: process.env.AGENTX_GATE_CLASSIFIER_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};
const gateClassifierTimeoutMs = classifierTimeoutMs(process.env.AGENTX_GATE_CLASSIFIER_TIMEOUT_MS);
// With the proxy, a classifier and a router are made for each turn (they need the turn's key), so none is made here.
const { classifier, available: classifierAvailable } = modelProxyEnabled
  ? { classifier: undefined, available: true }
  : await createHostedClassifier({ model: classifierModel, timeoutMs: gateClassifierTimeoutMs, log });
const confirmations = createDynamoConfirmationStore(documentClient, threadsTableName, Date.now, log);
// Task 21: plain top-level requests are routed with the same model setting, credentials and timeout (capped at 4 seconds).
const requestRouter = modelProxyEnabled ? undefined
  : await createHostedRequestRouter({ classifierAvailable, model: classifierModel, timeoutMs: gateClassifierTimeoutMs, log });

let botToken: { value: Promise<string>; loadedAt: number } | undefined;
function slackBotToken(): Promise<string> {
  if (!botToken || Date.now() - botToken.loadedAt > 5 * 60 * 1_000) {
    const value = secretsManager.send(new GetSecretValueCommand({ SecretId: slackSecretArn })).then((response) => {
      const secret = JSON.parse(response.SecretString ?? "{}") as { botToken?: unknown };
      if (typeof secret.botToken !== "string" || !secret.botToken.startsWith("xoxb-")) {
        throw new Error("Slack secret must contain an xoxb- botToken");
      }
      return secret.botToken;
    });
    botToken = { value, loadedAt: Date.now() };
    value.catch(() => {
      botToken = undefined;
    });
  }
  return botToken.value;
}

const slackUserName = createSlackUserNames({ token: slackBotToken });

/** Posts in a thread, or with no thread a new message in the channel; answers the message's timestamp. */
async function postToSlack(channel: string, threadTs: string | undefined, text: string, blocks?: unknown[], signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    headers: { authorization: `Bearer ${await slackBotToken()}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, ...(threadTs === undefined ? {} : { thread_ts: threadTs }), text, unfurl_links: false, ...(blocks === undefined ? {} : { blocks }) }),
  });
  const result = await response.json() as { ok?: boolean; error?: string; ts?: string };
  if (!response.ok || result.ok !== true) throw new SlackApiError("chat.postMessage", result.error ?? `HTTP ${response.status}`);
  return result.ts;
}

/** A message only `user` sees, in the thread (chat.postEphemeral). */
async function postEphemeralToSlack(channel: string, threadTs: string, user: string, text: string): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postEphemeral", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${await slackBotToken()}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, thread_ts: threadTs, user, text }),
  });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) throw new SlackApiError("chat.postEphemeral", result.error ?? `HTTP ${response.status}`);
}

/** Issue 219: edits the bot's own message (a long task's progress note). */
async function updateInSlack(channel: string, ts: string, text: string): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    // A progress edit that Slack does not answer is given up, never left waiting.
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${await slackBotToken()}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, ts, text }),
  });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) throw new SlackApiError("chat.update", result.error ?? `HTTP ${response.status}`);
}

/** Spec 052 Ruling 19: removes the bot's own message (a batch thread's opener that lost a race). */
async function deleteFromSlack(channel: string, ts: string): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: { authorization: `Bearer ${await slackBotToken()}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, ts }),
  });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) throw new SlackApiError("chat.delete", result.error ?? `HTTP ${response.status}`);
}

function threadApi(message: SlackRequestMessage): ThreadServiceApi {
  const signedFetch = createSignedServiceFetch({ region, credentials, thread: message.thread, userId: message.userId });
  return createThreadApi({ controlPlaneUrl, signedFetch });
}

// Task 13, R32: one access source per incoming message, shared by its router, its classifier and its orchestrator runtime.
const proxiedModels = modelProxyEnabled ? createProxiedModels({
  controlPlaneUrl,
  signedFetchFor: (message) => createSignedServiceFetch({ region, credentials, thread: message.thread, userId: message.userId }),
  classifierModel, orchestratorModel: model, classifierTimeoutMs: gateClassifierTimeoutMs, log,
  createClassifier: createHostedClassifier, createRouter: createHostedRequestRouter,
}) : undefined;

// Live interaction A3: an Ask about a task has no Slack thread or member. Its turn is keyed by the queue event's id; the Ask it belongs to is remembered here while the turn runs, so the model key is asked
// for on the Ask's own broker route (which names the Ask and checks the asker still "can use" the session) and never on a Slack thread's.
const askTurns = new Map<string, AskRef>();
const askProxiedModels = modelProxyEnabled ? createProxiedModels({
  controlPlaneUrl,
  signedFetchFor: () => createSignedServiceFetch({ region, credentials }),
  classifierModel, orchestratorModel: model, classifierTimeoutMs: gateClassifierTimeoutMs, log,
  createClassifier: createHostedClassifier, createRouter: createHostedRequestRouter,
  accessRouteFor: (message) => {
    const ref = askTurns.get(message.eventId);
    if (ref === undefined) throw new Error("no ask is running for this turn");
    return { orgId: ref.orgId, path: "/v1/asks/model-access", body: { sessionId: ref.sessionId, askId: ref.askId } };
  },
}) : undefined;

function routeOption(message: SlackRequestMessage): { route?: NonNullable<typeof requestRouter> } {
  const route = proxiedModels === undefined ? requestRouter : proxiedModels.routerFor(message);
  return route === undefined ? {} : { route };
}

const threads: ThreadStore = {
  async load(subject) {
    const response = await documentClient.send(new GetCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      ConsistentRead: true,
    }));
    const item = response.Item as {
      workspaceId?: string;
      conversationId?: string;
      settingsRevision?: number;
      closedAt?: string;
      refreshConnectors?: unknown;
      activeTurn?: unknown;
      turnNote?: unknown;
    } | undefined;
    const activeTurn = activeTurnFromItem(item?.activeTurn);
    const turnNote = turnNoteFromItem(item?.turnNote);
    return {
      ...(item?.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
      ...(item?.conversationId === undefined ? {} : { conversationId: item.conversationId }),
      ...(item?.settingsRevision === undefined ? {} : { settingsRevision: item.settingsRevision }),
      ...(item?.closedAt === undefined ? {} : { closedAt: item.closedAt }),
      ...(Array.isArray(item?.refreshConnectors) ? { refreshConnectors: item.refreshConnectors.filter((name): name is string => typeof name === "string") } : {}),
      ...(activeTurn === undefined ? {} : { activeTurn }),
      ...(turnNote === undefined ? {} : { turnNote }),
    };
  },
  // Issue 157: the worker operation a turn waits on, so a redelivery after a deploy can resume it.
  ...createDynamoActiveTurnStore(documentClient, threadsTableName),
  async saveConversation(subject, state) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      UpdateExpression: "SET workspaceId = :workspace, conversationId = :conversation",
      ExpressionAttributeValues: { ":workspace": state.workspaceId, ":conversation": state.conversationId },
    }));
  },
  async saveSettingsRevision(subject, revision) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      UpdateExpression: "SET settingsRevision = :revision",
      ExpressionAttributeValues: { ":revision": revision },
    }));
  },
  async close(subject, state) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      UpdateExpression: "SET workspaceId = :workspace, closedAt = :closedAt REMOVE conversationId, settingsRevision, refreshConnectors",
      ExpressionAttributeValues: { ":workspace": state.workspaceId, ":closedAt": state.closedAt },
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: sessionBucketName, Key: sessionKey(subject) }));
  },
  async saveRefreshConnectors(subject, connectors) {
    await documentClient.send(new UpdateCommand({
      TableName: threadsTableName,
      Key: { pk: `THREAD#${subject}`, sk: "META" },
      ...(connectors.length === 0
        ? { UpdateExpression: "REMOVE refreshConnectors" }
        : { UpdateExpression: "SET refreshConnectors = :connectors", ExpressionAttributeValues: { ":connectors": connectors } }),
    }), { abortSignal: AbortSignal.timeout(5000) });
  },
  async claimSharedNotice(subject, nowSeconds, kind) {
    try {
      // The same claim the Slack ingress sends (F13), so one notice an hour holds across both.
      await documentClient.send(new UpdateCommand({ TableName: threadsTableName, ...sharedNoticeClaim(subject, nowSeconds, kind) }), { abortSignal: AbortSignal.timeout(5000) });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  },
  async finish(subject) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: threadsTableName,
        Key: { pk: `THREAD#${subject}`, sk: "META" },
        UpdateExpression: "ADD pendingRequests :minusOne",
        ConditionExpression: "pendingRequests > :zero",
        ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
      }), { abortSignal: AbortSignal.timeout(5000) });
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
    }
  },
};

function sessionKey(subject: string): string {
  return `threads/${createHash("sha256").update(subject).digest("hex")}/session.jsonl`;
}

async function loadSession(subject: string): Promise<Uint8Array | undefined> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: sessionBucketName, Key: sessionKey(subject) }));
    return await response.Body?.transformToByteArray();
  } catch (error) {
    if (error instanceof NoSuchKey) return undefined;
    throw error;
  }
}

async function runTurn(input: TurnInput, ask?: AskRef): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stateDirectory, "thread-"));
  try {
    const sessions = join(directory, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    // A question about a task keeps no session: each answer reads the task's context afresh.
    const saved = input.answerOnly === true ? undefined : await loadSession(input.subject);
    const sessionFile = saved === undefined ? undefined : join(sessions, "thread.jsonl");
    if (sessionFile !== undefined && saved !== undefined) await writeFile(sessionFile, saved, { mode: 0o600 });
    // An Ask names no Slack thread or member (no thread headers, no name lookup); a Slack turn acts for its thread and member.
    const userName = ask === undefined ? await slackUserName(input.message.userId) : undefined;
    const signedFetch = createSignedServiceFetch({ region, credentials, ...(ask === undefined ? { thread: input.message.thread, userId: input.message.userId, ...(userName === undefined ? {} : { userName }) } : {}) });
    // One proxy and key for the whole message: the orchestrator's model and the gate's classifier share it (and the router's).
    const turn = await (ask === undefined ? proxiedModels : askProxiedModels)?.turnModels(input.message);
    const proxy = turn?.proxy;
    const turnClassifier = turn === undefined ? classifier : turn.classifier;
    // MODEL3: the model that ran in place of a missing-key one is said under the reply.
    let fallbackNote: string | undefined;
    const runtime = await createHostedSlackRuntime(input, {
      stateDirectory: directory,
      ...(proxy === undefined ? {} : { proxy }),
      ...(turn?.route === undefined ? {} : { modelRoute: turn.route }),
      onModelFallback: (notice) => { fallbackNote = notice.text; },
      api: new ControlPlaneApi(controlPlaneUrl, "slack-service", input.workspaceId, signedFetch),
      model,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      // Operators see why a connector was missing from a turn; the message is the control plane's sanitized error.
      onConnectorUnavailable: (failure) => log("connector.discovery_failed", {
        eventId: input.message.eventId, connector: failure.connector, cause: failure.cause, code: failure.code, message: failure.message,
      }),
      onExtensionError: (failure) => log("extension.handler_failed", {
        eventId: input.message.eventId, ...failure,
      }),
      ...(turnClassifier === undefined ? {} : { classifier: turnClassifier }),
      // The gate's own deadline follows the same setting, so a longer timeout is not cut at 8 seconds.
      classifierTimeoutMs: gateClassifierTimeoutMs,
      // One line per gate decision until turn records carry them; never the call's arguments.
      onGateDecision: (decision) => log("gate.decision", gateDecisionLogFields(input.message.eventId, decision)),
    });
    try {
      // Issue 157: a handed-off turn's model stops (or never starts), and its unfinished session is not saved.
      const response = await runHostedTurn(runtime, input.signal, () => runOrchestratorTurn(runtime, input.message.text, input.recorder), (error) => {
        log("turn.abort_failed", { eventId: input.message.eventId, errorName: error instanceof Error ? error.name : "unknown" });
      });
      const written = runtime.session.sessionManager.getSessionFile();
      if (input.answerOnly !== true && input.signal?.aborted !== true && written !== undefined && await exists(written)) {
        await s3.send(new PutObjectCommand({
          Bucket: sessionBucketName,
          Key: sessionKey(input.subject),
          Body: await readFile(written),
          ServerSideEncryption: "AES256",
        }));
      }
      return fallbackNote === undefined ? response : `${response}\n_I ${fallbackNote}._`;
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const queue: QueueClient = {
  async receive(maximum) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maximum,
      WaitTimeSeconds: 20,
      VisibilityTimeout: VISIBILITY_SECONDS,
      MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
      MessageAttributeNames: [SLACK_QUEUED_BEHIND_ATTRIBUTE, SLACK_ROUTE_ATTRIBUTE, SLACK_TASK_ID_ATTRIBUTE, SLACK_NOTE_TS_ATTRIBUTE, SLACK_CHAT_ATTRIBUTE],
    }));
    return (response.Messages ?? []).map((message) => {
      const queuedBehind = queuedBehindOf(message.MessageAttributes);
      const route = routeOf(message.MessageAttributes);
      const taskQuestion = taskQuestionOf(message.MessageAttributes);
      const pageComment = isPageCommentRoute(message.MessageAttributes);
      const askRoute = isAskRoute(message.MessageAttributes);
      return {
        body: message.Body ?? "",
        receiptHandle: message.ReceiptHandle ?? "",
        groupId: message.Attributes?.MessageGroupId ?? "",
        receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10),
        ...(queuedBehind === undefined ? {} : { queuedBehind }),
        ...(route === undefined ? {} : { route }),
        ...(taskQuestion === undefined ? {} : { taskQuestion }),
        ...(pageComment ? { pageComment: true as const } : {}),
        ...(askRoute ? { ask: true as const } : {}),
      };
    });
  },
  async delete(receiptHandle) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  },
  async extendVisibility(receiptHandle, seconds) {
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  },
};

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // Running turns get until the hand-off deadline (issue 157); nothing new starts.
    log("service.stopping", { signal, handoffMilliseconds: HANDOFF_MILLISECONDS });
    controller.abort();
  });
}

// Spec 052 Task 6: posts each eval batch's progress and summary in its thread until the service stops.
const batchWatcher = runEvalBatchWatcher({
  api: createEvalBatchWatchApi({
    controlPlaneUrl,
    signedFetchFor: (scope) => createSignedServiceFetch({ region, credentials, ...(scope === undefined ? {} : { thread: scope.thread, userId: scope.userId }) }),
  }),
  slack: {
    async post(channel, threadTs, text) {
      const ts = await postToSlack(channel, threadTs, text);
      if (ts === undefined) throw new Error("Slack chat.postMessage answered no message timestamp");
      return ts;
    },
    delete: deleteFromSlack,
  },
  log,
  logError: (event, fields) => console.error(JSON.stringify({ component: "slack-orchestrator", level: "error", event, ...fields })),
  signal: controller.signal,
});

log("service.started", {
  concurrency, provider: model.provider, model: model.modelId, modelProxy: modelProxyEnabled,
  classifierProvider: classifierModel.provider, classifierModel: classifierModel.modelId, classifierAvailable, requestRouting: modelProxyEnabled || requestRouter !== undefined,
});
const offerChoice = createChoiceOffer({ documentClient, tableName: threadsTableName, post: (thread, text, blocks) => postToSlack(thread.channelId, thread.threadTs, text, blocks), log });
await runConsumer(queue, (message, { route, taskQuestion, ...context }) => taskQuestion !== undefined
  ? handleTaskQuestion(message, taskQuestion, {
    ...routeOption(message),
    answer: (question) => runTaskAnswer(message, taskQuestion, question, { api: threadApi(message), runTurn, ...(context.handoff === undefined ? {} : { handoff: context.handoff }) }),
    post: async (thread, text) => { await postToSlack(thread.channelId, thread.threadTs, text); },
    postPrivate: (thread, userId, text) => postEphemeralToSlack(thread.channelId, thread.threadTs, userId, text),
    markAnswered: async (input) => {
      const api = threadApi(message);
      if (api.markThreadNoteAnswered === undefined) throw new Error("marking a note answered is unavailable in this deployment");
      await api.markThreadNoteAnswered(input);
    },
    finish: (subject) => threads.finish(subject),
    log })
  : route === "suggest"
  ? routeSlackRequest(message, { ...routeOption(message), offer: offerChoice,
    notify: async (thread, text) => { await postToSlack(thread.channelId, thread.threadTs, text); },
    answer: (question) => processRequest(question, context), finish: (subject) => threads.finish(subject), log })
  : processRequest(message, context), {
  concurrency,
  maxReceiveCount: MAX_RECEIVE_COUNT,
  visibilitySeconds: VISIBILITY_SECONDS,
  heartbeatMilliseconds: 5 * 60 * 1_000,
  signal: controller.signal,
  handoffMilliseconds: HANDOFF_MILLISECONDS,
  // Spec 061 slice 2: a task page comment, answered in task mode and written back; nothing is posted in Slack.
  pageComment: (comment, { handoff }) => {
    const { pageComment: target, ...request } = comment;
    const api = threadApi(request);
    return handlePageComment(comment, {
      answer: (question) => runTaskAnswer(request, target, question, { api, runTurn, ...(handoff === undefined ? {} : { handoff }) }),
      markAnswered: async (input) => {
        if (api.markCommentAnswered === undefined) throw new Error("comment answers are unavailable in this deployment");
        await api.markCommentAnswered(input);
      },
      log,
    });
  },
  // Live interaction A3: an Ask about a task (the web's or Linear's): the same read-only turn, with the context the broker built for the Ask's audience; nothing is posted in Slack.
  ask: (message, { handoff }) => {
    const askApi = createAskApi({ controlPlaneUrl, signedFetch: createSignedServiceFetch({ region, credentials }) });
    return handleAsk(message, {
      api: askApi,
      runTurn: async ({ ref, question, eventId, turn }) => {
        // The turn needs a message-shaped record for its models and logs; its ids are placeholders, used nowhere that reaches Slack or the broker.
        const placeholder = SlackRequestMessageSchema.parse({ version: 1, eventId, thread: { teamId: "T0000000000", channelId: "C0000000000", threadTs: "1700000000.000000" }, userId: "U0000000000", text: question, receivedAt: new Date().toISOString() });
        askTurns.set(eventId, ref);
        try {
          return await runTurn({
            message: placeholder, subject: `ask:${ref.askId}`, workspaceId: turn.workspaceId, conversationId: deterministicUuid(`${ref.askId}:ask-conversation`),
            orchestratorInstructions: turn.orchestratorInstructions, requestId: requestIdSequence(eventId), turnNote: turn.taskContext, answerOnly: true,
            ...(handoff === undefined ? {} : { signal: handoff }),
          }, ref);
        } finally {
          askTurns.delete(eventId);
        }
      },
      log,
    });
  },
  log,
});

function processRequest(message: SlackRequestMessage, context: Parameters<typeof processSlackRequest>[2]): Promise<void> {
  return processSlackRequest(message, {
    api: threadApi,
    threads,
    runTurn,
    post: async (thread, text) => { await postToSlack(thread.channelId, thread.threadTs, text); },
    log,
    confirmations,
    postConfirmation: async (thread, confirmation, text) => { await postToSlack(thread.channelId, thread.threadTs, text, confirmationBlocks(text, confirmation.confirmationId)); },
    postWithBlocks: async (thread, text, blocks) => { await postToSlack(thread.channelId, thread.threadTs, text, blocks); },
    // Issue 219: a progress post Slack does not answer is given up after ten seconds.
    postProgress: (thread, text) => postToSlack(thread.channelId, thread.threadTs, text, undefined, AbortSignal.timeout(10_000)),
    updateMessage: (thread, ts, text) => updateInSlack(thread.channelId, ts, text),
    turnRecords: new DynamoTurnRecordWriter(documentClient, turnRecordsTableName),
    userName: slackUserName,
  }, context);
}
// The watcher stops at its next pause; a pass still waiting on Slack or the broker is not waited for long (issue 157).
await Promise.race([batchWatcher, new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
log("service.stopped", {});
// Issue 157: a handed-off turn may still be winding down in this process; its message already
// belongs to the new task, so nothing here may run on until SIGKILL. Logs go to stdout, which is
// written synchronously for the awslogs driver's pipe on Linux.
process.exit(0);
