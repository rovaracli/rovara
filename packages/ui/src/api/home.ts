import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { HomeResponseReaderSchema, HomeCardSchema, HomeCardIdSchema, HomeDismissResponseReaderSchema, SessionIdSchema, type HomeCardReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { isConfirmUrl, safeAppPath, safeExternalUrl } from "../text/links.js";
export type ReadHomeCard = ReturnType<typeof HomeCardReaderSchema.parse>;
type ReadButton = ReadHomeCard["buttons"][number];
export type HomeAction = { kind: "internal" | "external" | "confirm" | "retry" | "dismiss" | "ticket_start" | "ticket_dismiss"; href: string; label: string };
/** Slice 5: a waiting ticket's Start and Not this one (the intake routes, same origin, no query). */
const TICKET_ACTION_PATH = /^\/v1\/app\/projects\/[^/?#]+\/intake\/[a-f0-9]{32}\/(start|dismiss)$/u;
export function homeAction(card: ReadHomeCard, button: ReadButton, origin: string): HomeAction | undefined {
 const { href, method, action, label } = button;
 if (href === undefined || method === undefined || safeExternalUrl(href) === undefined) return undefined;
 const known = HomeCardSchema.shape.kind.safeParse(card.kind).success;
 if (!known && action !== "open") return undefined;
 const url = new URL(href), sameOrigin = url.origin === new URL(origin).origin;
 // RULING Q39: controller requires same-origin absolute links for Open too.
 if (!sameOrigin) return undefined;
 if (action === "open" && method === "GET") {
  const path = href.slice(url.origin.length);
  return { kind: sameOrigin && safeAppPath(path) ? "internal" : "external", href: sameOrigin && safeAppPath(path) ? path : href, label };
 }
 if (action === "confirm" && method === "GET" && isConfirmUrl(href, origin)) return { kind: "confirm", href, label };
 if (!sameOrigin || method !== "POST" || url.hash || !href.startsWith(url.origin + "/")) return undefined;
 if (action === "retry" && SessionIdSchema.safeParse(card.sessionId).success && url.pathname === "/v1/app/sessions/" + card.sessionId + "/retry" && !url.search && href === url.origin + url.pathname) return { kind: "retry", href: url.pathname, label };
 if (action === "dismiss" && (card.kind === "failure" || card.kind === "offer") && HomeCardIdSchema.safeParse(card.cardId).success && url.pathname === "/v1/app/home/cards/" + encodeURIComponent(card.cardId) + "/dismiss" && href === url.origin + url.pathname + url.search) {
  const entries = [...url.searchParams];if (entries.length > 1 || entries.some(([key, value]) => key !== "occurrence" || value.length === 0)) return undefined;
  return { kind: "dismiss", href: url.pathname + url.search, label };
 }
 if ((action === "start" || action === "dismiss") && card.kind === "waiting_ticket" && !url.search && href === url.origin + url.pathname && TICKET_ACTION_PATH.test(url.pathname) && url.pathname.endsWith("/" + action)) return { kind: action === "start" ? "ticket_start" : "ticket_dismiss", href: url.pathname, label };
 // RULING Q39 / PLAN6: no start request until its owning route, body and response are defined.
 return undefined;
}
export function createHomeApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  dismissCard(card: ReadHomeCard, action: HomeAction) {
   if (action.kind !== "dismiss" || homeAction(card, { action: "dismiss", href: host.origin + action.href, method: "POST", label: action.label }, host.origin)?.href !== action.href) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   return api.send("POST", action.href, undefined, HomeDismissResponseReaderSchema);
  },
  retry(card: ReadHomeCard, action: HomeAction) {
   if (action.kind !== "retry" || homeAction(card, { action: "retry", href: host.origin + action.href, method: "POST", label: action.label }, host.origin)?.href !== action.href) throw new ApiError(403, "FORBIDDEN", "This action is unavailable.");
   // The session view (and the task view inside it) is read only after a retry, so it loads then, not with the first JavaScript.
   return import("./session-response.js").then(({ SessionResponseReaderSchema }) => api.send("POST", action.href, { requestId: crypto.randomUUID() }, SessionResponseReaderSchema));
  },
 };
}
export function useHome() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["home"], queryFn: () => api.get("/v1/app/home", HomeResponseReaderSchema) });
}
