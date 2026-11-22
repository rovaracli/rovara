import { QueryCache, QueryClient } from "@tanstack/react-query";
import { isAccessEnded } from "./served-read.js";
export function createQueryClient(): QueryClient {
 // RULING Q15: the API client owns the single bounded retry loop; Query must not multiply its attempts.
 return new QueryClient({ queryCache: new QueryCache({ onError(error, query) {
  // Query normally retains a success on error. An access signal must erase the payload,
  // but keep the last-success timestamp so identity failures still distinguish a recheck from a first read.
  if (isAccessEnded(error)) query.setState({ data: undefined });
 } }), defaultOptions: { queries: { staleTime: 15000, retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } } });
}
