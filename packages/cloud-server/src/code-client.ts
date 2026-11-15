// Rovara Cloud as a sign-in client of a Rovara Code install (Code specs 063, 065, 066): it signs people in through
// Code with PKCE and its own secret, then calls Code's API as the signed-in person with their token. Every call that
// answers 401 refreshes the token once and tries again.
import { createHash, randomBytes } from "node:crypto";
import type { SecretReader } from "./client-secret.js";
import type { CodeSession, RefreshGuard } from "./sessions.js";

export interface CodeClientOptions {
  /** The Code install's API, such as https://abc.execute-api.us-east-1.amazonaws.com. */
  baseUrl: string;
  clientId: string;
  /** The secret itself (this computer), or a reader that fetches it when needed (deployed: Secrets Manager). */
  clientSecret: string | SecretReader;
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

/** How long a call to Code's token or revoke endpoint may take: well inside a refresh's hold on the session. */
const TOKEN_CALL_MS = 10_000;

export class CodeClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /** One refresh at a time per session: calls made together that all get a 401 share it, so a rotated refresh token is used once. */
  private readonly refreshing = new WeakMap<CodeSession, Promise<"ok" | "ended" | "busy">>();
  private guard: RefreshGuard | undefined;

  constructor(private readonly options: CodeClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Refreshes go through the session store: one server at a time refreshes a session, and the new tokens are saved before
   * the call is retried (createCloudHandler sets this to its store).
   */
  useRefreshGuard(guard: RefreshGuard): void {
    this.guard = guard;
  }

  /** Ends the person's sign-in at Code (sign-out): Code's revoke endpoint with the refresh token. False when Code didn't confirm. */
  async revoke(session: CodeSession): Promise<boolean> {
    const token = session.refreshToken ?? session.accessToken;
    try {
      const response = await this.fetchImpl(`${this.base}/v1/auth/revoke`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: await this.basic() },
        body: new URLSearchParams({ token, token_type_hint: session.refreshToken === undefined ? "access_token" : "refresh_token" }),
        signal: AbortSignal.timeout(TOKEN_CALL_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async basic(): Promise<string> {
    const secret = typeof this.options.clientSecret === "string" ? this.options.clientSecret : await this.options.clientSecret();
    return `Basic ${Buffer.from(`${this.options.clientId}:${secret}`).toString("base64")}`;
  }

  /** Code's API address, with no trailing slash: where its own pages live, such as a task's page. */
  get baseUrl(): string {
    return this.base;
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
      const outcome = await pending;
      if (outcome === "busy") throw new CodeError(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Your Rovara sign-in is being renewed. Try again in a moment." } });
      if (outcome !== "ok") throw new SignInEnded();
    }
    const second = await send(session.accessToken);
    if (second.status === 401) throw new SignInEnded();
    return second;
  }

  /**
   * A new access token from the session's refresh token. With a guard (always, under createCloudHandler): only after the
   * store let this server refresh, and the new tokens are saved before this answers.
   */
  private async refresh(session: CodeSession): Promise<"ok" | "ended" | "busy"> {
    const guard = this.guard;
    if (session.refreshToken === undefined && guard === undefined) return "ended";
    // The secret is read before the hold on the session is taken, so a slow read never runs into the hold's time.
    const authorization = await this.basic();
    if (guard !== undefined) {
      const start = await guard.beginRefresh(session);
      if (start === "refreshed") return "ok";
      if (start !== "refresh") return start;
    }
    let answer: Awaited<ReturnType<CodeClient["tokenAnswer"]>>;
    try {
      answer = session.refreshToken === undefined ? { kind: "refused" } : await this.tokenAnswer({ grant_type: "refresh_token", refresh_token: session.refreshToken }, authorization);
    } catch (error) {
      // Code didn't answer: not an ended sign-in. Let the next caller try again.
      await guard?.abandonRefresh(session);
      throw error;
    }
    if (answer.kind === "failed") {
      // Code is down, rate-limiting or refused Cloud's secret: the sign-in itself is fine, so keep it.
      await guard?.abandonRefresh(session);
      throw new CodeError(503, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't renew your sign-in. Try again in a moment." } });
    }
    if (answer.kind === "ok") {
      session.accessToken = answer.tokens.accessToken;
      if (answer.tokens.refreshToken !== undefined) session.refreshToken = answer.tokens.refreshToken;
    }
    if (guard !== undefined) {
      let kept: boolean;
      try {
        kept = await guard.finishRefresh(session, answer.kind === "ok");
      } catch (error) {
        // The new tokens couldn't be saved: end them at Code rather than leave live tokens nobody holds.
        if (answer.kind === "ok") await this.revoke(session);
        throw error;
      }
      if (!kept && answer.kind === "ok") await this.revoke(session);
      return kept ? "ok" : "ended";
    }
    if (answer.kind !== "ok") return "ended";
    session.changed = true;
    return "ok";
  }

  private async token(form: Record<string, string>, authorization?: string): Promise<{ accessToken: string; refreshToken?: string } | undefined> {
    const answer = await this.tokenAnswer(form, authorization);
    return answer.kind === "ok" ? answer.tokens : undefined;
  }

  /** Code's token endpoint. "refused" only for invalid_grant (the grant is dead); any other failure is "failed" and ends nothing. */
  private async tokenAnswer(form: Record<string, string>, authorization?: string): Promise<{ kind: "ok"; tokens: { accessToken: string; refreshToken?: string } } | { kind: "refused" } | { kind: "failed" }> {
    const response = await this.fetchImpl(`${this.base}/v1/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: authorization ?? await this.basic(),
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TOKEN_CALL_MS),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown; error?: unknown };
    if (response.ok && typeof body.access_token === "string") {
      return { kind: "ok", tokens: { accessToken: body.access_token, ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}) } };
    }
    return response.status === 400 && body.error === "invalid_grant" ? { kind: "refused" } : { kind: "failed" };
  }

  private async accessWith(accessToken: string): Promise<CodeAccess | undefined> {
    const response = await this.fetchImpl(`${this.base}/v1/dev/access`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}" });
    return response.ok ? await response.json() as CodeAccess : undefined;
  }
}
