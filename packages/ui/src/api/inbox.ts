import { InboxReadResponseReaderSchema, type InboxReadBody } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { createInboxReadApi } from "./inbox-read.js";
export { inboxNotAvailable, useInboxBadge } from "./inbox-read.js";
export function createInboxApi(host: AppHost) {
 const api = createApiClient(host);
 return { ...createInboxReadApi(host), markRead: (body: InboxReadBody) => api.sendAnswer("POST", "/v1/app/inbox/read", body, InboxReadResponseReaderSchema) };
}
