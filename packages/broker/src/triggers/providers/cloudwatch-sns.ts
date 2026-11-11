// CloudWatch (Plan 4 Task 25): an alarm publishes to an SNS topic in the customer's AWS account, and the topic has an HTTPS subscription to this hook's URL. A hook names exactly one topic
// (and the account that owns it), so each subscription routes to exactly one org and project. There is no secret: a delivery is believed because its SNS signature verifies (`sns-verify.ts`,
// done by ingress before anything here runs) and its `TopicArn` is the hook's own. This file reads what ingress hands over after that: a `Notification`'s `Message`, which CloudWatch
// writes as the alarm's JSON (AWS's "Using Amazon CloudWatch alarms" and "Parsing Amazon SNS message formats"), and checks the `SubscribeURL` of a confirmation.
// The alarm's `AWSAccountId` must be the hook's account; only `NewStateValue: "ALARM"` becomes an event (`alarm.fired`). `StateChangeTime` is written with an offset that has no colon
// (`2017-01-12T16:30:42.236+0000`), which is read as the same time. Whoever may publish to the customer's topic can write any alarm into it, so the account check protects against
// another account's alarms, not against the customer's own principals. Rovara only reads CloudWatch, so there is no actor to guard against.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import type { HookHeaders, HookProvider, HookSetup, Normalized } from "./types.js";
import { isoOfText, titleOf, valuesOf } from "./shared.js";
import { parseSnsMessage, snsHostOfTopic, type SnsMessage } from "../sns-verify.js";

const SUBJECT_ID_CHARS = 200;
const URL_MAX_CHARS = 2048;

const Alarm = z.object({
  AWSAccountId: z.string(),
  NewStateValue: z.unknown(),
  AlarmName: z.unknown(),
  NewStateReason: z.unknown().optional(),
  StateChangeTime: z.unknown(),
  Trigger: z.object({ Namespace: z.unknown().optional() }).passthrough().nullish(),
}).passthrough();

type CloudWatchTenant = { awsAccountId: string; topicArn: string };

/** `+0000` (what CloudWatch writes) as `+00:00`, so it is read as the ISO 8601 time it is; every other form is left to be read, or refused, as it is. */
const withColon = (time: unknown): unknown => (typeof time === "string" ? time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : time);

/** The copy a person follows at AWS: this hook's topic in the words, one step. */
export function snsSetupSteps(topicArn: string): HookSetup {
  return { steps: [`Subscribe this URL to ${topicArn} with protocol HTTPS, and set the topic's SignatureVersion to 2. Leave raw message delivery off, because raw messages carry no signature. Rovara confirms the subscription itself.`] };
}

/**
 * The address to visit to confirm a subscription, only when it is SNS's own confirm action for exactly this topic: `https://sns.<the topic's region>.amazonaws.com/` with the parameters
 * `Action=ConfirmSubscription`, `TopicArn` (the hook's) and `Token` (the signed one) and no others, and no port, login or fragment. Anything else is undefined, and nothing is visited.
 */
export function confirmationTarget(message: SnsMessage, topicArn: string): URL | undefined {
  if (message.Type !== "SubscriptionConfirmation" || message.SubscribeURL === undefined || message.Token === undefined || message.Token === "") return undefined;
  const host = snsHostOfTopic(topicArn);
  const raw = message.SubscribeURL;
  if (host === undefined || !raw.startsWith(`https://${host}/?`) || raw.includes("#")) return undefined;
  // The prefix above fixes the scheme, the host (no port or login can follow it) and the path (`/`), so only the parameters are left to check.
  const url = new URL(raw);
  const names = [...url.searchParams.keys()].sort();
  if (names.join(",") !== "Action,Token,TopicArn") return undefined;
  const params = url.searchParams;
  return params.get("Action") === "ConfirmSubscription" && params.get("TopicArn") === topicArn && params.get("Token") === message.Token ? url : undefined;
}

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "cloudwatch") return { tenantMismatch: true };
  const tenant = hook.tenant as CloudWatchTenant;
  const message = parseSnsMessage(body);
  if (message === undefined) return { tenantMismatch: true };
  if (message.Type !== "Notification") return { ignored: "not a notification" };
  let alarmBody: unknown;
  try {
    alarmBody = JSON.parse(message.Message);
  } catch {
    return { tenantMismatch: true };
  }
  const parsed = Alarm.safeParse(alarmBody);
  if (!parsed.success || parsed.data.AWSAccountId !== tenant.awsAccountId) return { tenantMismatch: true };
  const alarm = parsed.data;
  if (alarm.NewStateValue !== "ALARM") return { ignored: "not an alarm that fired" };
  const name = titleOf(alarm.AlarmName, "");
  const occurredAt = isoOfText(withColon(alarm.StateChangeTime));
  if (name === "" || occurredAt === undefined) return { ignored: "an alarm that can't be read" };
  const region = tenant.topicArn.split(":")[3]!;
  const reason = titleOf(alarm.NewStateReason, "");
  const link = tenant.topicArn.startsWith("arn:aws:") ? `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}` : undefined;
  const event: TriggerEvent = {
    source: "cloudwatch", type: "alarm.fired", eventKey: `cw:${message.MessageId}`, occurredAt, project: hook.project,
    subject: {
      kind: "alert", id: [...name].slice(0, SUBJECT_ID_CHARS).join(""), title: titleOf(reason === "" ? name : `${name}: ${reason}`, name),
      ...(link === undefined || link.length > URL_MAX_CHARS ? {} : { url: link }),
    },
    fields: { alarm: valuesOf([name]), namespace: valuesOf([alarm.Trigger?.Namespace]), region: [region] },
    actor: { kind: "unknown" },
  };
  return { events: [event] };
}

export const cloudwatchProvider: HookProvider = {
  source: "cloudwatch", secretOrigin: "none", auth: "sns",
  // An SNS delivery has no secret; ingress checks its signature with `verifySnsMessage`, and a hook of this provider is never verified here.
  verify: () => false,
  setupFor: (hook) => (hook.source === "cloudwatch" ? snsSetupSteps((hook.tenant as CloudWatchTenant).topicArn) : undefined),
  normalize,
};
