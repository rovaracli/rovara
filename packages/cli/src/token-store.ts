import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";

const execFileAsync = promisify(execFile);

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface TokenStore {
  get(key: string): Promise<StoredTokens | undefined>;
  set(key: string, tokens: StoredTokens): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, StoredTokens>();

  async get(key: string): Promise<StoredTokens | undefined> {
    const value = this.tokens.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async set(key: string, tokens: StoredTokens): Promise<void> {
    this.tokens.set(key, structuredClone(tokens));
  }

  async delete(key: string): Promise<void> {
    this.tokens.delete(key);
  }
}

export class SystemCredentialTokenStore implements TokenStore {
  constructor(private readonly service = "dev.agentx.cli") {}

  async get(key: string): Promise<StoredTokens | undefined> {
    try {
      const serialized =
        process.platform === "darwin"
          ? (
              await execFileAsync(
                "security",
                ["find-generic-password", "-s", this.service, "-a", key, "-w"],
                { maxBuffer: 131_072 },
              )
            ).stdout
          : process.platform === "linux"
            ? (
                await execFileAsync(
                  "secret-tool",
                  ["lookup", "service", this.service, "account", key],
                  { maxBuffer: 131_072 },
                )
              ).stdout
            : unsupportedPlatform();
      return parseStoredTokens(serialized.trim());
    } catch (error) {
      const status = error as Error & { code?: number };
      if (status.code === 44 || status.code === 1) return undefined;
      throw error;
    }
  }

  async set(key: string, tokens: StoredTokens): Promise<void> {
    const serialized = JSON.stringify(parseStoredTokens(JSON.stringify(tokens)));
    if (process.platform === "darwin") {
      // The token goes to `security -i` on stdin, never into argv, where `ps` would show it to every process of this user.
      await spawnWithInput("security", ["-i"], buildSecurityAddCommand(this.service, key, serialized), {
        failOnStderr: true,
      });
      return;
    }
    if (process.platform === "linux") {
      await spawnWithInput(
        "secret-tool",
        ["store", "--label=AgentX CLI token", "service", this.service, "account", key],
        serialized,
      );
      return;
    }
    unsupportedPlatform();
  }

  async delete(key: string): Promise<void> {
    if (process.platform === "darwin") {
      await execFileAsync("security", ["delete-generic-password", "-s", this.service, "-a", key]).catch(
        () => undefined,
      );
      return;
    }
    if (process.platform === "linux") {
      await execFileAsync("secret-tool", ["clear", "service", this.service, "account", key]).catch(
        () => undefined,
      );
      return;
    }
    unsupportedPlatform();
  }
}

function parseStoredTokens(serialized: string): StoredTokens {
  const value = JSON.parse(serialized) as Record<string, unknown>;
  if (
    typeof value.accessToken !== "string" ||
    value.accessToken.length === 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    (value.refreshToken !== undefined && typeof value.refreshToken !== "string")
  ) {
    throw agentXError("AUTH_REQUIRED", "credential store contains an invalid AgentX token");
  }
  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
  };
}

// `security -i` reads one command per line into a 4096-byte buffer. A longer line is cut at the buffer edge: the cut
// prefix still runs and stores a truncated secret. Measured on macOS: a 4095-character line stored intact, longer ones
// stored a truncated value. Stay well under it and refuse instead of truncating.
const MAX_SECURITY_COMMAND_CHARS = 4000;

// Builds the `add-generic-password` line for `security -i`. Inside double quotes a backslash makes the next
// character literal, so escaping `\` and `"` is enough. The value is JSON with every non-ASCII character escaped as
// \uXXXX, so it is plain printable ASCII: no raw newline can end the line early, and `find-generic-password -w`
// prints it back as text (it prints non-ASCII data as hex).
function buildSecurityAddCommand(service: string, account: string, serialized: string): string {
  const value = serialized.replace(/[^\x20-\x7e]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const line = `add-generic-password -U -s ${quoteSecurityWord(service)} -a ${quoteSecurityWord(account)} -w ${quoteSecurityWord(value)}`;
  if (line.length > MAX_SECURITY_COMMAND_CHARS) {
    throw agentXError(
      "CONFIG_INVALID",
      "the sign-in token is too long to store in the macOS Keychain; it was not stored. Sign in again, or report this to your administrator.",
    );
  }
  return `${line}\n`;
}

function quoteSecurityWord(word: string): string {
  if (!/^[\x20-\x7e]*$/u.test(word)) {
    throw agentXError("CONFIG_INVALID", "the credential store name contains characters that cannot be stored safely");
  }
  return `"${word.replace(/[\\"]/gu, "\\$&")}"`;
}

async function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options: { failOnStderr?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.stdin.on("error", () => undefined); // a dead child is reported by its exit status
    child.on("close", (code) => {
      // Interactive `security` can print an error for one command and still exit 0, so any stderr is a failure.
      // Its error text can quote the rejected command, token included, so that text is not passed on.
      if (options.failOnStderr) {
        if (code === 0 && stderr.trim().length === 0) resolve();
        else reject(new Error(`${command} failed (exit ${code}); its output is withheld because it can echo the secret`));
      } else if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function unsupportedPlatform(): never {
  throw agentXError(
    "AUTH_REQUIRED",
    "no supported OS credential store is available; install macOS Keychain or Secret Service",
  );
}
