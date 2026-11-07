// UX2 slice 2 item 5: the person's own notification setting on their account page. `GET /v1/app/me/notifications` answers it with what it means now; `PUT` changes it (a channel, or the email's
// unsubscribe). Only the caller's own row, in their own org's partition. Email is offered only where the install has its sign-in notice sender (the identity notices' SES sender) and the person has
// an address; otherwise the setting says email isn't set up here and Slack is used.
import { agentXError, defaultNotifyChannel, effectiveNotify, NotificationPrefsBodySchema, type NotificationPrefsView } from "@agentx/contracts";
import { StatusReply } from "../aws/status-reply.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { jsonBody } from "../aws/developer-routes/organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { readPrefs, writePrefs } from "./attention.js";

export const NOTIFICATION_PREFS_PATH = "/v1/app/me/notifications";

/** The setting as the account page shows it. */
export async function notificationPrefsView(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "ownerNotice">, caller: Pick<DeveloperCaller, "orgId" | "developerId" | "slackUserId" | "email">): Promise<NotificationPrefsView> {
  const stored = await readPrefs(deps, caller.orgId, caller.developerId);
  const slackLinked = typeof caller.slackUserId === "string" && caller.slackUserId !== "";
  const emailAvailable = deps.ownerNotice?.ses !== undefined && typeof deps.ownerNotice.from === "string" && deps.ownerNotice.from !== "" && typeof caller.email === "string" && caller.email !== "";
  const channel = stored.channel ?? defaultNotifyChannel(slackLinked);
  const emailUnsubscribed = stored.emailUnsubscribed === true;
  return { channel, chosen: stored.channel !== undefined, slackLinked, emailAvailable, emailUnsubscribed, effective: effectiveNotify({ channel, slackLinked, emailAvailable, emailUnsubscribed }) };
}

export async function routeNotificationPrefs(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  if (url.pathname !== NOTIFICATION_PREFS_PATH) return undefined;
  if (request.method === "GET") return new StatusReply(200, await notificationPrefsView(deps, caller));
  if (request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
  const body = NotificationPrefsBodySchema.safeParse(jsonBody(request));
  if (!body.success) throw agentXError("CONFIG_INVALID", "choose slack, email or both");
  const stored = await readPrefs(deps, caller.orgId, caller.developerId);
  // Choosing email (or both) again turns email back on; the unsubscribe keeps the channel and stops email only.
  const next = "channel" in body.data
    ? { channel: body.data.channel, ...(body.data.channel === "slack" && stored.emailUnsubscribed === true ? { emailUnsubscribed: true as const } : {}) }
    : { ...(stored.channel === undefined ? {} : { channel: stored.channel }), emailUnsubscribed: true as const };
  await writePrefs({ ...deps, now: () => deps.now() }, caller.orgId, caller.developerId, next);
  return new StatusReply(200, await notificationPrefsView(deps, caller));
}
