// Rovara Cloud as a sign-in client of a Rovara Code install (Code specs 063, 065, 066): it signs people in through
// Code with PKCE and its own secret, then calls Code's API as the signed-in person with their token. Every call that
// answers 401 refreshes the token once and tries again.
import { createHash, randomBytes } from "node:crypto";
import type { CodeSession } from "./sessions.js";

export interface CodeClientOptions {
  /** The Code install's API, such as https://abc.execute-api.us-east-1.amazonaws.com. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Where Code sends the person back after sign-in: exactly a registered redirect URL, or a loopback one. */
  redirectUri: string;
  /** What Cloud asks to do as the person (spec 065); Code keeps only what the registration allows. */
  scopes: string;
  fetch?: typeof fetch;
}

/** Who the person is and what they can use (Code's access check, spec 063 FR-004). */
export interface CodeAccess {
  developerId: string;
  displayName: string;
  /** True once the person chose their own name in Code (PrepLabsAI/Rovara#634). An older Code leaves it out. */
  nameChosen?: boolean;
  administrator: boolean;
  projects: Array<{ name: string; access: string }>;
  notices: string[];
}

/** A failed call to Code, carrying Code's own status and error body so the route can pass them on. */
export class CodeError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Rovara Code answered ${String(status)}`);
  }
}

/** The person's sign-in has ended (no refresh possible): Cloud signs them out. */
export class SignInEnded extends Error {
  constructor() {
    super("the Rovara sign-in ended");
  }
}

export interface PendingSignIn { verifier: string; returnTo: string; at: number }

export class CodeClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /** One refresh at a time per session: calls made together that all get a 401 share it, so a rotated refresh token is used once. */
  private readonly refreshing = new WeakMap<CodeSession, Promise<boolean>>();

  constructor(private readonly options: CodeClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Step 1 of sign-in: the URL to send the browser to, and what to keep until it comes back. */
  startSignIn(returnTo: string, now: number): { url: string; state: string; pending: PendingSignIn } {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const url = new URL(`${this.base}/v1/auth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: this.options.clientId, redirect_uri: this.options.redirectUri, state, scope: this.options.scopes,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state, pending: { verifier, returnTo, at: now } };
  }

  /** Step 2: the code Code sent back, exchanged for the person's tokens, and who they are. */
  async finishSignIn(code: string, pending: PendingSignIn): Promise<{ accessToken: string; refreshToken?: string; access: CodeAccess }> {
    const tokens = await this.token({ grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: this.options.redirectUri });
    if (tokens === undefined) throw new CodeError(502, { error: { code: "SIGN_IN_FAILED", message: "Rovara Code didn't issue a token." } });
    const access = await this.accessWith(tokens.accessToken);
    if (access === undefined) throw new CodeError(502, { error: { code: "SIGN_IN_FAILED", message: "Rovara Code's access check refused the new sign-in." } });
    return { ...tokens, access };
  }

  /** The access check as the person; refreshes the session's token when it has expired. */
  async access(session: CodeSession): Promise<CodeAccess> {
    const access = await this.json<CodeAccess>(session, "/v1/dev/access", { method: "POST", body: {} });
    session.access = access;
    return access;
  }

  /** A JSON call to Code as the person. Throws CodeError for Code's refusals and SignInEnded when no refresh is possible. */
  async json<T>(session: CodeSession, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const response = await this.call(session, path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new CodeError(response.status, body);
    return body as T;
  }

  private async call(session: CodeSession, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const send = (token: string) => this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers: { ...init.headers, authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const used = session.accessToken;
    const first = await send(used);
    if (first.status !== 401) return first;
    // Another call may already have refreshed the token while this one was out.
    if (session.accessToken === used) {
      let pending = this.refreshing.get(session);
      if (pending === undefined) {
        pending = this.refresh(session).finally(() => { this.refreshing.delete(session); });
        this.refreshing.set(session, pending);
      }
      if (!await pending) throw new SignInEnded();
    }
    const second = await send(session.accessToken);
    if (second.status === 401) throw new SignInEnded();
    return second;
  }

  /** A new access token from the session's refresh token; false when the sign-in has ended. */
  private async refresh(session: CodeSession): Promise<boolean> {
    if (session.refreshToken === undefined) return false;
    const tokens = await this.token({ grant_type: "refresh_token", refresh_token: session.refreshToken });
    if (tokens === undefined) return false;
    session.accessToken = tokens.accessToken;
    if (tokens.refreshToken !== undefined) session.refreshToken = tokens.refreshToken;
    session.changed = true;
    return true;
  }

  private async token(form: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string } | undefined> {
    const response = await this.fetchImpl(`${this.base}/v1/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(form),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown };
    if (!response.ok || typeof body.access_token !== "string") return undefined;
    return { accessToken: body.access_token, ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}) };
  }

  private async accessWith(accessToken: string): Promise<CodeAccess | undefined> {
    const response = await this.fetchImpl(`${this.base}/v1/dev/access`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}" });
    return response.ok ? await response.json() as CodeAccess : undefined;
  }
}
