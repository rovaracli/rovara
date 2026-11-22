import type { AppHost } from "../host.js";
import type { Reader } from "./client.js";
import { createRequest, readResponse } from "./request.js";

/** GET capability only: view-only screens cannot import the write client. */
export function createReadClient(host: AppHost) {
 const request = createRequest(host);
 return {
  async get<T>(path: string, schema: Reader<T>, headers?: Record<string, string>, options?: { retry: "never" }): Promise<T> {
   return readResponse((await request({ method: "GET", path, ...(headers === undefined ? {} : { headers }), ...options })).body, schema);
  },
 };
}
