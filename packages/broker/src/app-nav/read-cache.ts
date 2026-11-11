import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, canonicalJson } from "@rovara-code/contracts";
import type { AgentStore } from "../agents/store.js";
const STORE_READS = new Set(["get", "list", "listShares", "pinnedBuiltinVersion"]);
const MAX_READS = 4096;
/** Only for the bounded lifetime of one navigation projection. Failed reads are never retained; unprocessed batches must be retried by their owner. */
export function navigationReadCache(source: { send(command: unknown): Promise<unknown> }) {
 let released = false;
 const pending = new Map<string, Promise<unknown>>();
 function once(key: string, read: () => Promise<unknown>): Promise<unknown> {
  if (released) return read();
  const existing = pending.get(key);if (existing !== undefined) return existing;
  const value = read();pending.set(key, value);
  if (pending.size > MAX_READS) { const first = pending.keys().next().value;if (first !== undefined) pending.delete(first); }
  void value.catch(() => { if (pending.get(key) === value) pending.delete(key); });return value;
 }
 const documentClient = { send(command: unknown): Promise<unknown> {
  if (command instanceof BatchGetCommand) return source.send(command);
  if (command instanceof GetCommand || command instanceof QueryCommand) return once(command.constructor.name + ":" + canonicalJson(command.input), () => source.send(command));
  return Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "Navigation attempted an unsupported operation."));
 } };
 function store(target: AgentStore): AgentStore {
  return new Proxy(target, { get(object, property) {
   const value: unknown = Reflect.get(object, property, object);
   if (typeof value !== "function") return value;
   if (typeof property !== "string" || !STORE_READS.has(property)) return value.bind(object) as unknown;
   return (...args: unknown[]) => once("store:" + property + ":" + canonicalJson(args), () => Promise.resolve(Reflect.apply(value, object, args) as unknown));
  } });
 }
 return { documentClient, store, get retainedReads() { return pending.size; }, release: () => { released = true;pending.clear(); } };
}
