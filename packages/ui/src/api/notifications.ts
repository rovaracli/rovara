// UX2 slice 2 item 5: the person's own notification setting (`/v1/app/me/notifications`). The server decides what each choice means; this file only reads and sends.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NotificationPrefsBodySchema, NotificationPrefsViewReaderSchema, type NotificationPrefsBody } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export const NOTIFICATIONS_PATH = "/v1/app/me/notifications";
export const notificationsKey = ["me", "notifications"] as const;

export function createNotificationsApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  read: () => api.get(NOTIFICATIONS_PATH, NotificationPrefsViewReaderSchema),
  save: (body: NotificationPrefsBody) => api.sendAnswer("PUT", NOTIFICATIONS_PATH, NotificationPrefsBodySchema.parse(body), NotificationPrefsViewReaderSchema, { retry: "never" }),
 };
}

export function useNotificationPrefs() {
 const host = useAppHost(), api = useMemo(() => createNotificationsApi(host), [host]);
 return { api, query: useQuery({ queryKey: notificationsKey, queryFn: () => api.read() }) };
}
