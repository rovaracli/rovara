import { SessionIdSchema, SessionPeopleCandidatesResponseReaderSchema, SessionPeopleChangeResponseReaderSchema, SessionPeopleResponseReaderSchema, type SessionPeopleAddBody, type SessionPeopleOwnershipBody, type SessionPeopleRoleBody } from "@agentx/contracts/web";
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

/** The People panel's calls (web task channel K3). The session is Cloud's `ses_` id; Cloud finds the task, and Rovara Code decides who may do what. */
export function createPeopleApi(host: AppHost) {
 const api = createApiClient(host), path = (id: string) => "/v1/app/sessions/" + encodeURIComponent(SessionIdSchema.parse(id)) + "/people";
 return {
  list: (id: string) => api.get(path(id), SessionPeopleResponseReaderSchema),
  candidates: (id: string) => api.get(path(id) + "/candidates", SessionPeopleCandidatesResponseReaderSchema),
  // A change answers its own body at 200 (done) or 202 (waiting for the person to confirm it in Code), so it is read with sendAnswer, never as a confirmation.
  role: (id: string, body: SessionPeopleRoleBody) => api.sendAnswer("POST", path(id) + "/role", body, SessionPeopleChangeResponseReaderSchema),
  add: (id: string, body: SessionPeopleAddBody) => api.sendAnswer("POST", path(id) + "/add", body, SessionPeopleChangeResponseReaderSchema),
  takeOwnership: (id: string, body: SessionPeopleOwnershipBody) => api.sendAnswer("POST", path(id) + "/take-ownership", body, SessionPeopleChangeResponseReaderSchema),
 };
}
