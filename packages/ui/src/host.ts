import { createContext, createElement, useContext, type ReactNode } from "react";
import type { RealtimeTokenResponse } from "@agentx/cloud-contracts/web";
export type ApiMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ApiRequest { method: ApiMethod; path: string; body?: unknown; headers?: Record<string, string>; retry?: "never" }
export interface ApiResponse { status: number; body: unknown; /** The company the server says it answered for (the `x-rovara-company` response header), when it sent one. Read only while the company switcher is on. */ company?: string }
export interface ApiTransport { request(input: ApiRequest): Promise<ApiResponse> }
export interface RealtimeSocket {
 onOpen(listener: () => void): () => void;
 onMessage(listener: (data: unknown) => void): () => void;
 onClose(listener: () => void): () => void;
 onError(listener: () => void): () => void;
 send(data: string): void;
 close(): void;
}
export interface AppHost {
 viewport?: { width(): number; subscribe(listener: () => void): () => void };
 kind: "web" | "desktop";origin: string;transport: ApiTransport;
 realtimeToken(): Promise<RealtimeTokenResponse>;
 // RULING Q14: routing and socket construction stay in the platform bridge, including desktop hosts.
 currentPath(): string;
 // RULING Q29: optional platform title bridge; shared screens never read document.title.
 setTitle?(title: string): void;
 // Lane A: explicit clipboard delivery of an in-memory private invite link.
 copyText?(text: string): Promise<void>;
 openSocket(url: string, protocols: string[]): RealtimeSocket;
 openExternal(this: void, url: string): void;navigate(url: string): void;saveFile(name: string, data: Blob): void;
 signIn(this: void, returnPath: string, options?: { automatic?: boolean; /** UX1: the person chose "Create a company"; only then does a new person's sign-in create one. */ createCompany?: boolean }): void;signOut(this: void): Promise<void>;
 storage: { get(key: string): string | undefined;set(key: string, value: string): void; /** Optional: a host that can list and remove its keys lets a company switch clear per-company drafts. */ remove?(key: string): void; keys?(): string[] };
 features: { admin: boolean };
}
const Context = createContext<AppHost | undefined>(undefined);
export function AppHostProvider({ host, children }: { host: AppHost; children: ReactNode }) { return createElement(Context.Provider, { value: host }, children); }
export function useAppHost(): AppHost { const host = useContext(Context);if (host === undefined) throw new Error("Rovara's host is unavailable.");return host; }
