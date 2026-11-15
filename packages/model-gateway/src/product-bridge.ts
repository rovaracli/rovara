// The engine bridge (Code's worker -> the gateway's product route). Mirrored byte-for-byte by
// contracts/shared/model-gateway-product-ai.v1.json, which Code's worker copies (a test pins its SHA-256 in both repos).
//
// How a product call travels: the customer's test in the sandbox calls the worker's local port with a DUMMY Google key (it
// never holds the real one, nor the task token). The worker's trusted part removes the dummy key headers and any `key=`
// query, adds the TC-1 task token it already holds for the task (from GET /v1/internal/model-access, key purpose "task",
// Code #670) as `x-api-key`, and forwards to `<baseUrl>/v1/product/gemini/...`. The gateway refuses a request that still
// carries a Google credential or a URL key, so a sandbox can't reach it directly with a token in Google's places.
import { PRODUCT_KEY_REFUSED, PRODUCT_NOT_SET_UP, PRODUCT_OVER_BY_ONE_CALL, PRODUCT_PROVIDER_LIMITED, PRODUCT_PROVIDER_REFUSED } from "./product-route.js";
import { GEMINI_HOST, GEMINI_MODEL, GEMINI_VERSIONS } from "./product-gemini.js";
import { PRODUCT_ROUTE_PREFIX } from "./server.js";
import { AUTH_ERROR } from "./token.js";
import { TASK_KEY_PURPOSE } from "./model-gateway-token.js";

export const PRODUCT_BRIDGE_VERSION = 1;
export const PRODUCT_BRIDGE = {
  version: PRODUCT_BRIDGE_VERSION,
  token: { contract: "model-gateway-token.v1.json", keyPurpose: TASK_KEY_PURPOSE, source: "GET /v1/internal/model-access", headers: ["x-api-key", "authorization: Bearer"] },
  routePrefix: PRODUCT_ROUTE_PREFIX,
  providers: [{
    name: "gemini", upstreamHost: GEMINI_HOST,
    paths: ["/v1/product/gemini/{version}/models/{model}:generateContent", "/v1/product/gemini/{version}/models/{model}:streamGenerateContent?alt=sse"],
    versions: [...GEMINI_VERSIONS], model: GEMINI_MODEL.source,
    workerRemovesHeaders: ["x-goog-api-key", "x-goog-user-project", "authorization"], workerRemovesQuery: ["key"],
  }],
  refusals: [
    { status: 401, type: AUTH_ERROR.error.type, message: AUTH_ERROR.error.message },
    { status: 403, type: "task_ended", message: "task ended" },
    { status: 404, type: "not_set_up", message: PRODUCT_NOT_SET_UP },
    { status: 422, type: "budget_exceeded", message: PRODUCT_OVER_BY_ONE_CALL },
    { status: 422, type: "budget_exceeded", messagePrefix: "Product AI budget has been exceeded! " },
    { status: 429, type: "busy", retryAfter: true },
    { status: 429, type: "budget_held", retryAfter: true },
    { status: 429, type: "provider_limited", message: PRODUCT_PROVIDER_LIMITED },
    { status: 400, type: "provider_refused", message: PRODUCT_PROVIDER_REFUSED },
    { status: 502, type: "product_key_refused", message: PRODUCT_KEY_REFUSED },
  ],
} as const;
