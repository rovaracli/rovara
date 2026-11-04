"use strict";
// Plain HTTP calls to Rovara local AWS from inside a check, with no SDK: an unsigned-looking request that names its service in the credential scope (the emulator does not check signatures; this project only needs it to tell
// the service). The endpoint is the one the run gave the check (AWS_ENDPOINT_URL_S3 / _SQS / _DYNAMODB, all the same address); the ESCAPE_AWS_ENDPOINT override is honoured only under ESCAPE_FIXTURE_TEST=1 (lib/fixture.js).
const http = require("node:http");
const { setting } = require("./fixture.js");

/** The emulator's base URL, or undefined when the run gave none (a test must then FAIL: nothing to attack proves nothing). */
function endpoint(name = "AWS_ENDPOINT_URL_S3") {
  return setting("ESCAPE_AWS_ENDPOINT") || process.env[name];
}

/** One request. Resolves { status, body } or { error: code } when nothing answered. Never rejects. */
function call(base, { method = "GET", path = "/", headers = {}, body, service, timeoutMs } = {}) {
  const url = new URL(path, base);
  const merged = { ...headers };
  if (service) merged.authorization = `AWS4-HMAC-SHA256 Credential=ROVARATESTKEY/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`;
  if (body !== undefined) merged["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolve) => {
    const request = http.request({ hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method, headers: merged, timeout: timeoutMs || Number(setting("ESCAPE_CONNECT_TIMEOUT_MS")) || 5000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => { if (Buffer.concat(chunks).length < 65536) chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("timeout", () => { request.destroy(); resolve({ error: "timeout" }); });
    request.once("error", (error) => resolve({ error: (error && error.code) || "error" }));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

module.exports = { endpoint, call };
