import { createContext, createElement, useContext, type ReactNode } from "react";
import type { RealtimeTokenResponse } from "@agentx/contracts/web";
export type ApiMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ApiRequest { method: ApiMethod; path: string; body?: unknown; headers?: Record<string, string>; retry?: "never" }
export interface ApiResponse { status: number; body: unknown }
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
 signIn(this: void, returnPath: string, options?: { automatic?: boolean; /** "Sign in to join": the invite the join page looked up (lookUpInvite) picks the company, on Cloud's server. */ join?: boolean; /** L4-SIGNIN: the sign-in page's own button for one method ("Sign in with Slack" / "Sign in with GitHub"). */ method?: "slack" | "github"; /** L4-SIGNIN: "Use a different workspace": sign in with no remembered Slack workspace, and forget it. */ differentWorkspace?: boolean }): void;signOut(this: void): Promise<void>;
 /** L4-SIGNIN: which sign-in buttons Code offers (Slack, GitHub); undefined when that cannot be read, and the page then shows its one plain Sign in button. Absent on a host with one button. */
 signInOffer?(this: void): Promise<{ slack: boolean; github: boolean } | undefined>;
 /** L4-SIGNIN: the Slack workspace id this browser last signed in with (a non-sensitive id kept only here), or undefined. */
 lastWorkspace?(this: void): string | undefined;
 /** L4-SIGNIN: once signed in, keeps the Slack workspace of this sign-in as the browser's last workspace. Never throws. */
 rememberSignInWorkspace?(this: void): Promise<void>;
 /** The join page (DEC 253z): looks up the invite link this page was opened with, on Cloud's server. Undefined when the link can't be used. Absent on a host without invite links. */
 lookUpInvite?(this: void): Promise<{ companyName: string } | undefined>;
 storage: { get(key: string): string | undefined;set(key: string, value: string): void };
 features: { admin: boolean };
}
const Context = createContext<AppHost | undefined>(undefined);
export function AppHostProvider({ host, children }: { host: AppHost; children: ReactNode }) { return createElement(Context.Provider, { value: host }, children); }
export function useAppHost(): AppHost { const host = useContext(Context);if (host === undefined) throw new Error("Rovara's host is unavailable.");return host; }
