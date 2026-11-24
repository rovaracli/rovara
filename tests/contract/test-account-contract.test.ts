// Test services TS4 (contract): the test-account record (a reference, never a value), the org-tagged secret name, the key-shape table that refuses live-shaped keys, and the production deny-list checks.
// Every key-shaped string below is built at runtime from parts: the public repository's push protection refuses a key-shaped literal.
import { describe, expect, it } from "vitest";
import * as shared from "../../packages/contracts/src/test-services-shared.js";
// Key-shaped values, built here so no literal in this file is one.
const build = (...parts: string[]) => parts.join("");
const rand = (length: number) => "Qk7mP2xR9vLw4NtY8bZc3HdF6gJs1VaUeXoI5".repeat(3).slice(0, length);
const stripeLive = () => build("sk", "_", "live", "_", rand(24));
const stripeTest = () => build("sk", "_", "test", "_", rand(24));
const awsKeyId = (prefix = "AKIA") => build(prefix, "ABCDEFGHIJKLMNOP");

describe("looksLikeSecretValue", () => {
  it("finds each specific shape even when it is too short for the generic long-token rule", () => {
    for (const text of [build("sk", "_", "live", "_", rand(10)), build("sk", "_", "test", "_", rand(10)), build("gh", "o_", rand(20)), build("github", "_pat_", rand(20)), build("xox", "a-", rand(10)), build("ey", "J", rand(10), ".", rand(10), ".", rand(10))]) {
      // No run of token characters reaches 32 (dots break the JWT's runs), so only the specific rule can find it.
      expect(Math.max(...text.split(".").map((part) => part.length)), text.slice(0, 8)).toBeLessThan(32);
      expect(shared.looksLikeSecretValue(`note ${text}`), text.slice(0, 8)).toBe(true);
    }
  });
  it("finds every known shape, live or test", () => {
    for (const text of [stripeLive(), stripeTest(), awsKeyId(), awsKeyId("ASIA"), build("gh", "p_", rand(30)), build("gh", "s_", rand(30)), build("github", "_pat_", rand(30)), build("xox", "p-", rand(20)), build("ey", "J", rand(20), ".", rand(20), ".", rand(20)), build("-----", "BEGIN PRIVATE KEY"), rand(40)]) expect(shared.looksLikeSecretValue(`note: ${text}`), text.slice(0, 8)).toBe(true);
  });
  it("leaves ordinary words alone", () => {
    for (const text of ["Payments test mode", "Dev AWS (orders)", "CRM sandbox for the orders-service", "ABC-123", "a".repeat(31)]) expect(shared.looksLikeSecretValue(text), text).toBe(false);
  });
});

describe("environment variable names (shared rule)", () => {
  const prefixes = ["PYTHON", "NPM_CONFIG_", "PIP_", "UV_", "YARN_", "GO", "CARGO_", "XDG_", "SSL", "OPENSSL_", "GLIBC_", "GCONV_", "BASH", "KUBE", "GOOGLE_", "AZURE_", "ANTHROPIC_", "OPENAI_", "AGENTX_", "ROVARA_", "AWS_", "GIT_", "LD_", "DYLD_", "PI_", "DOCKER_"];
  const names = [
    "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "HOSTALIASES", "TMPDIR", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "FTP_PROXY", "MAVEN_OPTS", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "RUBYOPT", "PERL5OPT", "PERL5LIB",
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV", "CLASSPATH", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "RUBYLIB", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "DOCKER_HOST",
  ];
  it.each(prefixes)("reserves every name starting %s", (prefix) => {
    for (const name of [`${prefix}X`, `${prefix}SOMETHING_ELSE`, `${prefix}1`]) {
      expect(shared.reservedDependencyEnvName(name), name).toBe(true);
      expect(shared.reservedDependencyEnvName(name.toLowerCase()), name.toLowerCase()).toBe(true);
    }
  });
  it.each(names)("reserves the name %s", (name) => {
    expect(shared.reservedDependencyEnvName(name)).toBe(true);
  });
});

describe("hosts that can be read as an address (shared host rule)", () => {
  it("accepts ordinary names, including ones with digits and hyphens", () => {
    for (const host of ["api.example-pay.com", "a.io", "sandbox.api2.example.com", "xn--p1ai.xn--p1ai", "1password.example.com", "api-1.example.org", "x.dev"]) {
      expect(shared.hostProblem(host), host).toBeUndefined();
      expect(shared.TestServiceHostSchema.safeParse(host).success, host).toBe(true);
    }
  });
  it("says why, in fixed codes", () => {
    expect(shared.hostProblem("0x7f.0x1")).toBe("address_shaped");
    expect(shared.hostProblem("0177.0.0.1")).toBe("address_shaped");
    expect(shared.hostProblem("127.1")).toBe("address_shaped");
    expect(shared.hostProblem("api.example.0x1")).toBe("numeric_label");
    expect(shared.hostProblem("localhost")).toBe("single_label");
    expect(shared.hostProblem("Api.example.com")).toBe("shape");
    expect(shared.hostProblem("")).toBe("shape");
    expect(shared.hostProblem("a".repeat(254))).toBe("shape");
  });
});
