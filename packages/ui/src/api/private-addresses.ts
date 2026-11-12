// The calls of the company's "Internal addresses" screen (owner decision 123): the exact internal host:port pairs the company's tasks may reach through the sandbox wall. The server decides who may, what an addition
// needs (a different owner or admin) and what a refusal says; this file only sends and reads. Every write is sent once from the browser session (`retry: "never"`). A 202 (an addition waits for a second admin) is an
// answer of its own, read with `sendAnswer`.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { useAppHost, type AppHost } from "../host.js";
import { PRIVATE_ADDRESSES_PATH, PrivateAddressesAnswerReaderSchema, PrivateAddressesBodySchema, PrivateAddressesStateReaderSchema, type PrivateAddressesBody } from "@agentx/cloud-contracts/web";
import { createApiClient } from "./client.js";

export { PRIVATE_ADDRESSES_PATH, PrivateAddressesAnswerReaderSchema, PrivateAddressesBodySchema, PrivateAddressesStateReaderSchema } from "@agentx/cloud-contracts/web";
export type { PrivateAddressesBody, PrivateAddressesState } from "@agentx/cloud-contracts/web";
export type PrivateAddressesAnswer = z.output<typeof PrivateAddressesAnswerReaderSchema>;

const NEVER = { retry: "never" } as const;

export function createPrivateAddressesApi(host: AppHost) {
 const api = createApiClient(host);
 const send = (body: PrivateAddressesBody) => api.sendAnswer("POST", PRIVATE_ADDRESSES_PATH, PrivateAddressesBodySchema.parse(body), PrivateAddressesAnswerReaderSchema, NEVER);
 return {
  state: () => api.get(PRIVATE_ADDRESSES_PATH, PrivateAddressesStateReaderSchema),
  /** The whole new list. Only removals apply at once; anything added waits for a different owner or admin (`needs_approval`). */
  propose: (expectedRevision: number, entries: string[]) => send({ action: "propose", expectedRevision, entries }),
  /** A DIFFERENT admin approves the list they were shown (its digest); the server asks for a sign-in within the last 10 minutes and refuses the proposer. */
  approve: (changeId: string, expectedDigest: string) => send({ action: "approve", changeId, expectedDigest }),
  withdraw: (changeId: string) => send({ action: "withdraw", changeId }),
 };
}
export function usePrivateAddressesApi() { const host = useAppHost();return useMemo(() => createPrivateAddressesApi(host), [host]); }
export const privateAddressesKey = (orgId: string, developerId: string) => ["admin", "private-addresses", orgId, developerId] as const;
export function usePrivateAddresses(orgId: string, developerId: string) { const api = usePrivateAddressesApi();return useQuery({ queryKey: privateAddressesKey(orgId, developerId), queryFn: () => api.state(), refetchOnWindowFocus: false, retry: false }); }
