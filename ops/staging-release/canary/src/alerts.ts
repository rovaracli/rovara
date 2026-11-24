// Alerts: every one is published to BOTH topics (the OperatorAlerts email topic and the release-alerts topic that AWS Chatbot posts to Slack). Publishing never throws and
// one topic failing never stops the other; the delivery result is returned so it lands in result.json. A topic that is not configured (Slack before the owner's one-time
// setup) is reported as "not-configured", which the run summary shows as "Slack: not configured".
import { plain, errorText } from "./util.ts";
import type { CanaryPorts, Topics } from "./types.ts";

export interface Alert {
  /** A stable machine code: canary-fail, canary-inconclusive, canary-skipped-cap, rollback-started, rollback-refused, rollback-finished, rollback-failed, hold-set, decision-<code>. */
  code: string;
  title: string;
  message: string;
  pipeline: string;
  sha: string;
  executionId: string;
  verdict?: string;
  s3Path?: string;
}

export interface AlertDelivery {
  code: string;
  operator: string;
  slack: string;
}

export function emailSubject(alert: Alert): string {
  return plain(`rovara release ${alert.pipeline}: ${alert.title}`.replace(/\n/g, " "), 100);
}

export function emailBody(alert: Alert): string {
  return [
    plain(alert.title, 200),
    "",
    plain(alert.message, 1500),
    "",
    `pipeline: ${plain(alert.pipeline, 20)}`,
    `sha: ${plain(alert.sha, 40)}`,
    `execution: ${plain(alert.executionId, 40)}`,
    ...(alert.verdict === undefined ? [] : [`verdict: ${plain(alert.verdict, 40)}`]),
    ...(alert.s3Path === undefined ? [] : [`details: ${plain(alert.s3Path, 200)}`]),
  ].join("\n");
}

/** AWS Chatbot's custom notification (version 1.0, source custom): one title and one description, so one short line per alert in the channel. */
export function chatbotBody(alert: Alert): string {
  const description = [plain(alert.message, 600), `sha ${plain(alert.sha, 40)}`, `exec ${plain(alert.executionId, 40)}`, ...(alert.verdict === undefined ? [] : [`verdict ${plain(alert.verdict, 40)}`]), ...(alert.s3Path === undefined ? [] : [plain(alert.s3Path, 200)])].join(" | ");
  return JSON.stringify({
    version: "1.0",
    source: "custom",
    content: { title: plain(`${alert.pipeline}: ${alert.title}`, 200), description },
    metadata: { threadId: plain(`${alert.pipeline}-${alert.executionId}`, 100), summary: plain(alert.title, 100), eventType: plain(alert.code, 60) },
  });
}

async function one(ports: Pick<CanaryPorts, "publish">, topicArn: string | null, subject: string, message: string): Promise<string> {
  if (topicArn === null || topicArn === "") return "not-configured";
  try {
    await ports.publish(topicArn, subject, message);
    return "ok";
  } catch (error) {
    return `failed: ${errorText(error)}`;
  }
}

export async function publishAlert(ports: Pick<CanaryPorts, "publish">, topics: Topics, alert: Alert): Promise<AlertDelivery> {
  const subject = emailSubject(alert);
  // Both are always attempted, even when the first fails.
  const operator = await one(ports, topics.operator, subject, emailBody(alert));
  const slack = await one(ports, topics.slack, subject, chatbotBody(alert));
  return { code: alert.code, operator, slack };
}

export async function publishAll(ports: Pick<CanaryPorts, "publish">, topics: Topics, alerts: readonly Alert[]): Promise<AlertDelivery[]> {
  const out: AlertDelivery[] = [];
  for (const alert of alerts) out.push(await publishAlert(ports, topics, alert));
  return out;
}

/** The evaluator's non-blocking notes (Decision.alerts, for example audit-backlog-rollback-allowed) become alerts too. */
export function fromDecisionAlerts(decisionAlerts: readonly { rule: string; code: string; message: string }[], base: { pipeline: string; sha: string; executionId: string; s3Path?: string }): Alert[] {
  return decisionAlerts.map((a) => ({
    code: `decision-${plain(a.code, 60)}`,
    title: `evaluator note: ${plain(a.code, 60)}`,
    message: plain(`${a.rule}: ${a.message}`, 600),
    pipeline: base.pipeline,
    sha: base.sha,
    executionId: base.executionId,
    ...(base.s3Path === undefined ? {} : { s3Path: base.s3Path }),
  }));
}
