// The device and local-agent-rule routes (Plan 5 Task 17): `GET` and `POST /v1/app/devices`, `DELETE /v1/app/devices/{id}`, and `GET` and `PUT /v1/app/org/local-agents`.
// Task 18 adds the device's command poll (`GET /v1/app/devices/{id}/commands`) here, and ends a removed device's sessions in the removal. Any other path or method under these prefixes is `NOT_FOUND`.
import { agentXError } from "@rovara-code/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { StatusReply } from "../aws/status-reply.js";
import { endSessionsOfDevice, listDeviceCommands } from "./local-sessions.js";
import { putLocalAgentPolicy, readLocalAgentPolicyWithRevision } from "./policy.js";
import { listOwnDevices, registerDevice, revokeDevice, type DeviceCaller, type DeviceDependencies } from "./store.js";

export type DeviceRouteDependencies = DeviceDependencies;

const DEVICES_PATH = "/v1/app/devices";
const DEVICE_PATH = /^\/v1\/app\/devices\/([^/]+)$/;
const DEVICE_COMMANDS_PATH = /^\/v1\/app\/devices\/([^/]+)\/commands$/;
const LOCAL_AGENTS_PATH = "/v1/app/org/local-agents";

/** The paths this module owns under `/v1/app/`. */
export function isDeviceRoute(pathname: string): boolean {
  return /^\/v1\/app\/devices(\/|$)/.test(pathname) || pathname === LOCAL_AGENTS_PATH;
}

const notFound = () => agentXError("NOT_FOUND", "route not found");

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

export async function routeDeviceRequest(deps: DeviceRouteDependencies, caller: DeviceCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  if (url.pathname === DEVICES_PATH) {
    if (request.method === "GET") return { devices: await listOwnDevices(deps, caller) };
    if (request.method === "POST") return new StatusReply(201, { device: await registerDevice(deps, caller, jsonBody(request)) });
    throw notFound();
  }
  const device = DEVICE_PATH.exec(url.pathname);
  if (device !== null) {
    if (request.method === "DELETE") {
      const removed = await revokeDevice(deps, caller, device[1]!);
      // The sessions that run on it end now (Task 18); asked again, a removal that stopped part-way is finished here.
      await endSessionsOfDevice(deps, caller.orgId, removed.deviceId);
      return { deviceId: removed.deviceId, revoked: true };
    }
    throw notFound();
  }
  const commands = DEVICE_COMMANDS_PATH.exec(url.pathname);
  if (commands !== null) {
    if (request.method !== "GET") throw notFound();
    return listDeviceCommands(deps, caller, commands[1]!, url.searchParams.get("after") ?? undefined);
  }
  if (url.pathname === LOCAL_AGENTS_PATH) {
    if (request.method === "GET") return readLocalAgentPolicyWithRevision(deps, caller.orgId);
    if (request.method === "PUT") return putLocalAgentPolicy(deps, caller, jsonBody(request));
    throw notFound();
  }
  throw notFound();
}
