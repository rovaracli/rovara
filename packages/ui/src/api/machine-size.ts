import { ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { useMemo } from "react";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";

export interface MachineSizeView {
  measuredPeakMemoryMiB: number | null;
  testTimeMs: number | null;
  suggestedSize: string | null;
  currentSize: string | null;
  storedOnlyLine: string;
  choices: Array<{ id: string; label: string }>;
}
const reader = { parse(value: unknown): MachineSizeView {
  if (value === null || typeof value !== "object") throw new Error("invalid");
  const v = value as Record<string, unknown>;
  if (!(v["measuredPeakMemoryMiB"] === null || typeof v["measuredPeakMemoryMiB"] === "number") || !(v["testTimeMs"] === null || typeof v["testTimeMs"] === "number") || !(v["suggestedSize"] === null || typeof v["suggestedSize"] === "string") || !(v["currentSize"] === null || typeof v["currentSize"] === "string") || typeof v["storedOnlyLine"] !== "string" || !Array.isArray(v["choices"])) throw new Error("invalid");
  return v as unknown as MachineSizeView;
} };
export function createMachineSizeApi(host: ReturnType<typeof useAppHost>) {
  const api = createApiClient(host);
  const path = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/machine-size";
  return { read: (name: string) => api.get(path(name), reader), set: (name: string, rowId: string) => api.sendAnswer("POST", path(name), { rowId }, reader, { retry: "never" }) };
}
export function useMachineSizeApi() { const host = useAppHost(); return useMemo(() => createMachineSizeApi(host), [host]); }
