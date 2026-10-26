import { QueryClient } from "@tanstack/react-query";
export function createQueryClient(): QueryClient {
 // RULING Q15: the API client owns the single bounded retry loop; Query must not multiply its attempts.
 return new QueryClient({ defaultOptions: { queries: { staleTime: 15000, retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } } });
}
