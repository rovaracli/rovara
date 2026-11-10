"""Rovara proxy guard: loaded by LiteLLM as a callback module (litellm_settings.callbacks: rovara_guard.proxy_handler_instance).

1. Per-route allow-list of request body fields (anything else is refused with HTTP 400), recursing into fallback
   targets, plus refusal of x-litellm-* and billing/identity request headers. Inside "tools", only plain function tools
   pass: a provider-side tool (web search, code execution, MCP, computer use, file search, image generation) would reach
   the internet from the provider's side, outside the worker's egress allow-list, and is billed outside token usage.
2. In-process no-redirect patch: every httpx client send is forced to follow_redirects=False.
3. Start-up self-test: the proxy refuses to start if a redirect would still be followed.
4. Task budget held before forwarding: a call on a key with a max_budget first takes its worst-case cost from the key's room
   in a ledger the guard keeps in LiteLLM's own Postgres (shared by every replica), and settles it to the real cost when the
   call ends. A call cut before its cost is known (worker cut, provider cut, timeout, replica crash) is charged in full.
   422 budget_exceeded: the spend leaves no room for this call. 429 budget_held (retry-after): only other calls' holds block it.
"""
import asyncio, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

# ---------------------------------------------------------------- 2. no-redirect patch
_PATCHED = os.environ.get("ROVARA_DISABLE_NO_REDIRECT_PATCH") != "1"
if _PATCHED:
    _async_send, _sync_send = httpx.AsyncClient.send, httpx.Client.send

    async def _no_redirect_async_send(self, request, *args, **kwargs):
        kwargs["follow_redirects"] = False
        return await _async_send(self, request, *args, **kwargs)

    def _no_redirect_send(self, request, *args, **kwargs):
        kwargs["follow_redirects"] = False
        return _sync_send(self, request, *args, **kwargs)

    httpx.AsyncClient.send = _no_redirect_async_send
    httpx.Client.send = _no_redirect_send

# ---------------------------------------------------------------- 3. start-up self-test
def _self_test():
    hits = []

    class Target(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self): hits.append(self.path); self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
        do_POST = do_GET

    class Redirector(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _go(self):
            n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n) if n else None
            self.send_response(307); self.send_header("Location", f"http://127.0.0.1:{target.server_port}/followed"); self.send_header("Content-Length", "0"); self.end_headers()
        do_GET = do_POST = _go

    target = ThreadingHTTPServer(("127.0.0.1", 0), Target); redirector = ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
    for s in (target, redirector): threading.Thread(target=s.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{redirector.server_port}"
    problems = []

    def check(name, fn):
        before = len(hits)
        try: fn()
        except Exception: pass                      # an error response from a refused redirect is expected
        if len(hits) != before: problems.append(name)

    def run_async(coro_fn):
        def go():
            loop = asyncio.new_event_loop()
            try: loop.run_until_complete(coro_fn())
            finally: loop.close()
        return go

    check("httpx.Client(follow_redirects=True)", lambda: httpx.Client(follow_redirects=True).post(base + "/x", json={}))
    check("httpx.AsyncClient(follow_redirects=True)", run_async(lambda: httpx.AsyncClient(follow_redirects=True).post(base + "/x", json={})))

    async def sdk_openai():
        import openai
        c = openai.AsyncOpenAI(base_url=base + "/v1", api_key="x", max_retries=0)
        await c.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
    check("openai SDK", run_async(sdk_openai))

    async def sdk_anthropic():
        import anthropic
        c = anthropic.AsyncAnthropic(base_url=base, api_key="x", max_retries=0)
        await c.messages.create(model="m", max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    check("anthropic SDK", run_async(sdk_anthropic))

    async def litellm_handler():
        from litellm.llms.custom_httpx.http_handler import get_async_httpx_client
        from litellm.types.utils import LlmProviders
        h = get_async_httpx_client(llm_provider=LlmProviders.OPENAI)
        await h.post(url=base + "/x", data="{}")
    check("litellm AsyncHTTPHandler", run_async(litellm_handler))

    async def litellm_acompletion():
        import litellm
        await litellm.acompletion(model="openai/m", api_base=base + "/v1", api_key="x", messages=[{"role": "user", "content": "hi"}], num_retries=0)
    check("litellm.acompletion openai", run_async(litellm_acompletion))

    async def litellm_aresponses():
        import litellm
        await litellm.aresponses(model="openai/m", api_base=base + "/v1", api_key="x", input="hi", num_retries=0)
    check("litellm.aresponses openai", run_async(litellm_aresponses))

    async def litellm_anthropic():
        import litellm
        await litellm.acompletion(model="anthropic/m", api_base=base, api_key="x", messages=[{"role": "user", "content": "hi"}], num_retries=0, max_tokens=8)
    check("litellm.acompletion anthropic", run_async(litellm_anthropic))

    for s in (target, redirector): s.shutdown()
    return problems

_problems = _self_test()
print(f"rovara_guard: no-redirect self-test {'FAILED: ' + ', '.join(_problems) if _problems else 'passed'} (patch {'on' if _PATCHED else 'OFF'})", flush=True)
if _problems:
    print("rovara_guard: refusing to start, a redirect would be followed", file=sys.stderr, flush=True)
    os._exit(70)

# ---------------------------------------------------------------- 1. request allow-list
INJECTED_TOP = {"litellm_call_id", "litellm_logging_obj", "proxy_server_request", "secret_fields", "provider_specific_header"}
# keys LiteLLM v1.105.1 puts in the injected metadata dict on a clean request (a client-sent extra key such as tags is not in this set)
INJECTED_METADATA_KEYS = frozenset(['actor_agent_id', 'agent_execution_mode', 'agent_id', 'billing_agent_id', 'caller_tags', 'endpoint', 'global_max_parallel_requests', 'headers', 'inherited_tags', 'litellm_api_version', 'litellm_parent_otel_span', 'litellm_received_at', 'llm_api_timing_windows', 'queue_time_seconds', 'requester_ip_address', 'requester_metadata', 'target_agent_id', 'used_client_oauth_token', 'user_agent', 'user_api_end_user_max_budget', 'user_api_key', 'user_api_key_alias', 'user_api_key_auth', 'user_api_key_auth_metadata', 'user_api_key_budget_reset_at', 'user_api_key_end_user_id', 'user_api_key_end_user_model_max_budget', 'user_api_key_hash', 'user_api_key_max_budget', 'user_api_key_metadata', 'user_api_key_model_max_budget', 'user_api_key_object_permission_id', 'user_api_key_org_alias', 'user_api_key_org_id', 'user_api_key_project_alias', 'user_api_key_project_id', 'user_api_key_request_route', 'user_api_key_spend', 'user_api_key_team_alias', 'user_api_key_team_id', 'user_api_key_team_max_budget', 'user_api_key_team_metadata', 'user_api_key_team_model_max_budget', 'user_api_key_team_object_permission_id', 'user_api_key_team_spend', 'user_api_key_user_email', 'user_api_key_user_id', 'user_api_key_user_max_budget', 'user_api_key_user_model_max_budget', 'user_api_key_user_spend', 'verified_human_user_id'])
ROUTE_FIELDS = {
    "anthropic_messages": {"model", "messages", "max_tokens", "stream", "system", "temperature", "thinking", "output_config", "tool_choice", "tools"},
    "aresponses": {"model", "input", "stream", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "store", "max_output_tokens",
                   "temperature", "reasoning", "include", "tool_choice", "tools"},
    "acompletion": {"model", "messages", "stream", "stream_options", "store", "max_tokens", "max_completion_tokens", "temperature", "reasoning_effort",
                    "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "tool_choice", "tools", "tool_stream", "provider",
                    "prompt_cache_key", "prompt_cache_retention"},
}
CALL_TYPES = {"anthropic_messages": "anthropic_messages", "aresponses": "aresponses", "responses": "aresponses", "acompletion": "acompletion", "completion": "acompletion", "text_completion": None}
FALLBACK_FIELDS = ("fallbacks", "context_window_fallbacks", "content_policy_fallbacks", "router_settings_override")
CREDENTIAL_NAMES = {"api_key", "extra_headers", "headers", "api_base", "base_url", "organization", "aws_region_name", "aws_access_key_id",
                    "aws_secret_access_key", "aws_session_token", "service_tier", "extra_body", "extra_query", "litellm_credential_name", "models", "route"}
OPENROUTER_PROVIDER_KEYS = {"allow_fallbacks", "require_parameters", "data_collection", "only", "order", "ignore", "sort", "zdr", "max_price", "quantizations"}
# The one tool type each route accepts. Anthropic: a client tool has no type or "custom"; every typed tool (web_search_*, web_fetch_*,
# code_execution_*, computer_*, bash_*, text_editor_*, memory_*, tool_search_*, mcp_toolset, ...) is defined by the provider (and most are run by it).
# OpenAI chat and Responses: "function" only (refuses mcp, web_search*, code_interpreter, file_search, image_generation, computer_use*,
# local_shell, custom, tool_search, namespace, ...).
ROUTE_TOOL_TYPES = {"anthropic_messages": {None, "custom"}, "aresponses": {"function"}, "acompletion": {"function"}}
RESPONSES_INCLUDE = {"reasoning.encrypted_content"}      # the only include value Pi sends; the others only add output of a hosted tool call
# Blocks whose "input" is the model's own tool arguments (any JSON, may contain a key named "tools"): not tool definitions, not walked.
ARGUMENT_BLOCKS = {"tool_use", "server_tool_use", "mcp_tool_use"}
TOOL_CHOICE_TYPES = {"auto", "any", "none", "required", "tool", "function"}
BANNED_HEADERS = ("openai-organization", "openai-project", "x-api-key-override")
ALLOWED_BETAS = {"fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"}


def _refuse(message):
    raise HTTPException(status_code=400, detail=f"request not allowed: {message}")


def _deep_names(value, path="", out=None):
    """Names of credential-bearing fields anywhere inside a structure (used for fallback targets)."""
    out = [] if out is None else out
    if isinstance(value, dict):
        for k, v in value.items():
            if k in CREDENTIAL_NAMES: out.append(f"{path}{k}")
            _deep_names(v, f"{path}{k}.", out)
    elif isinstance(value, list):
        for i, v in enumerate(value): _deep_names(v, f"{path}{i}.", out)
    return out


def _short(where):
    """A path in a refusal message, capped so a deeply nested body cannot make the 400 body large."""
    return where if len(where) <= 200 else where[:200] + "..."


def _check_tools(route, tools, where="tools"):
    """Refuse any tool that is not a plain function (client-side) tool; the message names the offending type."""
    if tools is None:
        return
    if not isinstance(tools, list):
        _refuse(f"field {_short(where)} (must be a list of function tools)")
    allowed = ROUTE_TOOL_TYPES[route]
    for i, tool in enumerate(tools):
        _check_tool(allowed, tool, f"{where}[{i}]")


def _check_tool(allowed, tool, where):
    if not isinstance(tool, dict):
        _refuse(f"{_short(where)} is not a function tool")
    kind = tool.get("type")
    if (kind is not None and not isinstance(kind, str)) or kind not in allowed:
        shown = kind[:64] if isinstance(kind, str) else type(kind).__name__
        _refuse(f"tool type {shown!r} at {_short(where)} (only function tools are served: provider-side tools such as web search, code execution, MCP, computer use and file search are refused)")


def _check_nested_tools(route, body):
    """Tool definitions can also travel inside the conversation: Responses input items (additional_tools, tool_search_output carry a
    tools list) and Anthropic messages (a tool_addition block carries a tool_definition). Walk input, messages and system, and hold every such
    list or definition to the same rule as the top-level tools. Iterative, so a deeply nested body cannot raise RecursionError."""
    for field in ("input", "messages", "system"):
        if field not in body:
            continue
        stack = [(field, body[field])]
        while stack:
            where, value = stack.pop()
            if isinstance(value, list):
                stack.extend((f"{where}[{i}]", v) for i, v in enumerate(value))
            elif isinstance(value, dict):
                if "tools" in value:
                    _check_tools(route, value["tools"], f"{where}.tools")
                if value.get("type") == "tool_addition":
                    tool = value.get("tool")
                    if not isinstance(tool, dict) or tool.get("type") != "tool_definition":
                        _refuse(f"tool_addition without a tool_definition at {_short(where)}")
                if value.get("type") == "tool_definition":
                    _check_tool(ROUTE_TOOL_TYPES["anthropic_messages"], value.get("definition"), f"{where}.definition")
                skip_input = value.get("type") in ARGUMENT_BLOCKS
                stack.extend((f"{where}.{k}", v) for k, v in value.items() if k != "tools" and not (skip_input and k == "input"))


def _check_tool_choice(choice):
    """A tool_choice may name a function, never a provider-side tool type."""
    if choice is None or isinstance(choice, str):
        return
    kind = choice.get("type") if isinstance(choice, dict) else None
    if not isinstance(kind, str) or kind not in TOOL_CHOICE_TYPES:
        shown = kind[:64] if isinstance(kind, str) else "unknown"
        _refuse(f"tool_choice type {shown!r} (only auto, any, none, required, tool and function are served)")


def _check_include(include):
    if include is None:
        return
    if not isinstance(include, list) or any(not isinstance(v, str) or v not in RESPONSES_INCLUDE for v in include):
        _refuse("field include (only reasoning.encrypted_content is served)")


# ---------------------------------------------------------------- 4. task budget: hold the worst case before forwarding
import asyncio, json, math, re, sys, time as _time, uuid as _uuid

HOLD_SECONDS = 1000                 # longer than the proxy's 900 s REQUEST_TIMEOUT: an older hold is an orphan (its replica died) and counts as spent
SETTLE_GRACE_SECONDS = 60           # a call that ended but whose cost never arrived is charged its whole hold after this long
HELD_RETRY_AFTER_SECONDS = 2
MIN_AFFORDABLE_OUTPUT_TOKENS = 4_096  # below this a smaller output limit is not offered: the spend leaves no room for a useful call (422)
MAX_TOKENS_HINT_HEADER = "x-rovara-max-tokens"
ASSUMED_MAX_OUTPUT_TOKENS = 64_000  # a request that names no output limit, for a model whose limit is not known (as the Code proxy assumes)
ASSUMED_MAX_INPUT_TOKENS = 2_000_000
_MICROS = 1_000_000
# Every per-token rate a call's tokens could be billed at (long-context tiers and the 1-hour cache write included, batch-only rates excluded by the max).
_INPUT_RATE = re.compile(r"^(input_cost_per_token|cache_creation_input_token_cost)(_above_[a-z0-9_]+)?$")
_OUTPUT_RATE = re.compile(r"^output_cost_per_(token|reasoning_token)(_above_[a-z0-9_]+)?$")
_PER_CALL = re.compile(r"^(input_|output_)?cost_per_request$")
# Its own schema, outside the public schema LiteLLM's Prisma migrations manage, so no LiteLLM migration can drop it.
_SCHEMA = (
    "CREATE SCHEMA IF NOT EXISTS rovara_budget",
    "CREATE TABLE IF NOT EXISTS rovara_budget.keys (key_hash text PRIMARY KEY, charged_micros bigint NOT NULL DEFAULT 0,"
    " held_micros bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())",
    "CREATE TABLE IF NOT EXISTS rovara_budget.holds (call_id text PRIMARY KEY, key_hash text NOT NULL, reserved_micros bigint NOT NULL,"
    " expires_at timestamptz NOT NULL)",
    "CREATE INDEX IF NOT EXISTS holds_key ON rovara_budget.holds (key_hash, expires_at)",
)
# An orphan (older than HOLD_SECONDS) leaves the holds and is added to what its key has been charged. One statement: a hold is moved once.
_SQL_SWEEP = (
    "WITH gone AS (DELETE FROM rovara_budget.holds WHERE key_hash = $1::text AND expires_at < now() RETURNING reserved_micros),"
    " s AS (SELECT COALESCE(SUM(reserved_micros), 0)::bigint AS n FROM gone)"
    " UPDATE rovara_budget.keys k SET charged_micros = k.charged_micros + s.n, held_micros = k.held_micros - s.n, updated_at = now()"
    " FROM s WHERE k.key_hash = $1::text AND s.n > 0")
_SQL_SWEEP_ALL = (
    "WITH gone AS (DELETE FROM rovara_budget.holds WHERE expires_at < now() RETURNING key_hash, reserved_micros),"
    " s AS (SELECT key_hash, SUM(reserved_micros)::bigint AS n FROM gone GROUP BY key_hash)"
    " UPDATE rovara_budget.keys k SET charged_micros = k.charged_micros + s.n, held_micros = k.held_micros - s.n, updated_at = now()"
    " FROM s WHERE k.key_hash = s.key_hash")
_SQL_FORGET = "DELETE FROM rovara_budget.keys WHERE held_micros = 0 AND updated_at < now() - interval '45 days'"
_SQL_ENSURE = "INSERT INTO rovara_budget.keys (key_hash) VALUES ($1::text) ON CONFLICT (key_hash) DO NOTHING"
# The take: the key's row is locked by the UPDATE, so two replicas taking at once are serialised and the second sees the first's hold.
_SQL_TAKE = (
    "WITH k AS (UPDATE rovara_budget.keys SET held_micros = held_micros + $2::bigint, updated_at = now()"
    " WHERE key_hash = $1::text AND GREATEST(charged_micros, $3::bigint) + held_micros + $2::bigint <= $4::bigint RETURNING key_hash)"
    " INSERT INTO rovara_budget.holds (call_id, key_hash, reserved_micros, expires_at)"
    " SELECT $5::text, key_hash, $2::bigint, now() + make_interval(secs => $6::int) FROM k RETURNING call_id")
_SQL_READ = "SELECT charged_micros, held_micros FROM rovara_budget.keys WHERE key_hash = $1::text"
# Settle: the hold leaves and its key is charged the call's cost ($2), or the whole hold when $2 is negative. Settling twice charges once.
_SQL_SETTLE = (
    "WITH h AS (DELETE FROM rovara_budget.holds WHERE call_id = $1::text RETURNING key_hash, reserved_micros)"
    " UPDATE rovara_budget.keys k SET held_micros = k.held_micros - h.reserved_micros,"
    " charged_micros = k.charged_micros + CASE WHEN $2::bigint < 0 THEN h.reserved_micros ELSE $2::bigint END, updated_at = now()"
    " FROM h WHERE k.key_hash = h.key_hash RETURNING k.charged_micros")


class _PostgresLedger:
    """The holds, in LiteLLM's own database (the connection LiteLLM opened, through its Prisma client). The tables are created on first use."""

    def __init__(self):
        self._ready = False
        self._init = None                                   # one schema set-up at a time on this replica (a lock, made on first use)

    async def _db(self):
        from litellm.proxy.proxy_server import prisma_client
        if prisma_client is None:
            raise RuntimeError("the proxy has no database")
        db = prisma_client.db
        if not self._ready:
            if self._init is None:
                self._init = asyncio.Lock()
            async with self._init:
                if not self._ready:                         # another call set it up while this one waited
                    for statement in _SCHEMA:
                        try:
                            await db.execute_raw(statement)
                        except Exception:
                            await db.execute_raw(statement)     # the other replica created it in the same instant: IF NOT EXISTS holds now
                    await db.execute_raw(_SQL_SWEEP_ALL)
                    await db.execute_raw(_SQL_FORGET)
                    self._ready = True
        return db

    async def take(self, key, call_id, worst, spent, cap):
        """('ok' | 'exceeded' | 'held', charged micros): held; the spend leaves no room for this call; only other calls' holds are in the way."""
        db = await self._db()
        try:
            await db.execute_raw(_SQL_ENSURE, key)
            await db.execute_raw(_SQL_SWEEP, key)
            if await db.query_raw(_SQL_TAKE, key, worst, spent, cap, call_id, HOLD_SECONDS):
                return "ok", None
            rows = await db.query_raw(_SQL_READ, key)
        except Exception:
            self._ready = False                             # the tables are created again on the next call if they went
            raise
        charged = int(rows[0]["charged_micros"]) if rows else 0
        return ("exceeded" if max(charged, spent) + worst > cap else "held"), charged

    async def settle(self, call_id, cost):
        """Ends a hold: its key is charged cost micro-dollars, or the whole hold when cost is None."""
        db = await self._db()
        try:
            await db.query_raw(_SQL_SETTLE, call_id, -1 if cost is None else cost)
        except Exception:
            self._ready = False
            raise


_LEDGER = _PostgresLedger()


def _proxy_error(route, status, kind, message, headers=None):
    """A refusal with its own error type. /v1/messages rewrites an error into Anthropic's shape by its status (422 -> api_error, 429 -> rate_limit_error)
    unless the message already is an Anthropic error body, so on that route the message is one, carrying the type."""
    from litellm.proxy._types import ProxyException
    if route == "anthropic_messages":
        message = json.dumps({"type": "error", "error": {"type": kind, "message": message}})
    return ProxyException(message=message, type=kind, param=None, code=status, headers=headers)


def _micros_up(usd):
    return int(math.ceil(float(usd) * _MICROS - 1e-6))


def _rates(entries):
    """(input rate, output rate, max output tokens, max input tokens, fixed price per call) over the given price dicts: the dearest rate any of them
    names; every per-request price is added once at its dearest."""
    rate_in = rate_out = 0.0
    max_out = max_in = None
    per_call = {}
    for entry in entries:
        for name, value in entry.items():
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            if _PER_CALL.match(name): per_call[name] = max(per_call.get(name, 0.0), float(value))
            elif _INPUT_RATE.match(name): rate_in = max(rate_in, float(value))
            elif _OUTPUT_RATE.match(name): rate_out = max(rate_out, float(value))
            elif name == "max_output_tokens" and value > 0: max_out = int(value) if max_out is None else min(max_out, int(value))
            elif name == "max_input_tokens" and value > 0: max_in = int(value) if max_in is None else min(max_in, int(value))
    return rate_in, rate_out, max_out, max_in, sum(per_call.values())


def _prices_for(alias):
    """The dearest price of every deployment serving this model name: the deployment's own prices (a company source's) and LiteLLM's cost map
    (shipped in the image, LITELLM_LOCAL_MODEL_COST_MAP). None when the name has no deployment or no positive input and output price."""
    import litellm
    from litellm.proxy.proxy_server import llm_router
    deployments = (llm_router.get_model_list(model_name=alias) if llm_router is not None and isinstance(alias, str) else None) or []
    found = None
    for deployment in deployments:
        params = dict(deployment.get("litellm_params") or {})
        entries = [params, dict(deployment.get("model_info") or {})]
        model = params.get("model")
        if isinstance(model, str):
            try: entries.append(dict(litellm.get_model_info(model=model) or {}))
            except Exception: pass
            mapped = litellm.model_cost.get(model) or litellm.model_cost.get(model.split("/", 1)[-1])
            if isinstance(mapped, dict): entries.append(mapped)
        rate_in, rate_out, max_out, max_in, per_call = _rates(entries)
        if rate_in <= 0 or rate_out <= 0:
            return None
        if found is None:
            found = (rate_in, rate_out, max_out, max_in, per_call)
        else:
            found = (max(found[0], rate_in), max(found[1], rate_out),
                     None if found[2] is None or max_out is None else max(found[2], max_out), None if found[3] is None or max_in is None else max(found[3], max_in),
                     max(found[4], per_call))
    return found


def _request_bytes(data):
    sent = {k: v for k, v in data.items() if k not in INJECTED_TOP and k not in ("metadata", "litellm_metadata")}
    return len(json.dumps(sent, ensure_ascii=False, default=str).encode("utf-8"))


# Media containers (by their type, or by the key that holds them) and the keys that name media by reference inside one.
_MEDIA = frozenset({"image", "document", "image_url", "input_image", "input_file", "file", "input_audio", "audio", "video", "file_data"})
_MEDIA_REFERENCES = frozenset({"url", "image_url", "file_url", "file_uri", "uri", "file_id"})


def _remote_media(data):
    """Whether the request names media by reference (an image or document URL, a file id or URI, an S3 location) instead of carrying it: the provider
    (or LiteLLM) fetches it after this hook, so its size, and its tokens, are not in the request's bytes. Only references inside a media block count, so a
    URL in text, a citation or the model's own tool arguments does not."""
    stack = [(v, False) for k, v in data.items() if k not in INJECTED_TOP and k not in ("metadata", "litellm_metadata")]
    while stack:
        value, in_media = stack.pop()
        if isinstance(value, list):
            stack.extend((v, in_media) for v in value)
        elif isinstance(value, dict):
            media = in_media or value.get("type") in _MEDIA
            if media and any(isinstance(v, str) and k in _MEDIA_REFERENCES and not v.startswith("data:") for k, v in value.items()):
                return True
            skip_input = value.get("type") in ARGUMENT_BLOCKS
            stack.extend((v, media or k in _MEDIA) for k, v in value.items() if not (skip_input and k == "input"))
    return False


def _worst_case_micros(data, prices):
    """The most this call could cost: its output limit (the largest it names; else the model's, else 64,000) at the dearest output rate, plus one input
    token per byte of the request (no tokenizer makes more tokens than bytes; the model's whole input limit when it names media by reference) at the
    dearer of the input and cache-write rates, plus any fixed price per call."""
    rate_in, rate_out, max_out, max_in, per_call = prices
    asked = [int(v) for v in (data.get("max_tokens"), data.get("max_output_tokens"), data.get("max_completion_tokens"))
             if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0]
    output = min(max(asked) if asked else (max_out or ASSUMED_MAX_OUTPUT_TOKENS), 1_000_000)
    whole_input = min(max_in or ASSUMED_MAX_INPUT_TOKENS, ASSUMED_MAX_INPUT_TOKENS)
    tokens_in = whole_input if _remote_media(data) else min(_request_bytes(data), whole_input)
    return _micros_up(output * rate_out + tokens_in * rate_in + per_call)


def _affordable_output(data, prices, room):
    """The largest output limit, in whole thousands of tokens, whose worst case fits in room (micro-dollars) when the request is sent again with it, or None
    when that is under MIN_AFFORDABLE_OUTPUT_TOKENS."""
    rate_out = prices[1]
    if rate_out <= 0:
        return None
    limits = ("max_tokens", "max_output_tokens", "max_completion_tokens")
    named = [f for f in limits if f in data] or ["max_tokens"]
    again = lambda tokens: dict(data, **{f: tokens for f in named})
    fixed = _worst_case_micros(again(1), prices) - _micros_up(rate_out)
    tokens = int((room - fixed) / (rate_out * _MICROS)) // 1000 * 1000
    while tokens >= MIN_AFFORDABLE_OUTPUT_TOKENS and _worst_case_micros(again(tokens), prices) > room:
        tokens -= 1000
    return tokens if tokens >= MIN_AFFORDABLE_OUTPUT_TOKENS else None


def _timed_out(exc):
    """A failure after the provider may have started generating: a timeout or a cancellation (499: the client went away). Any other failure is an error answer, which is not billed."""
    name = type(exc).__name__
    return getattr(exc, "status_code", None) in (408, 499) or "Timeout" in name or "Cancelled" in name


class RovaraGuard(CustomLogger):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._calls = {}        # litellm_call_id -> this replica's open holds: {"stream", "started", "ended", "cost", "at", "worst", "timed_out"}
        self._tasks = set()

    def _spawn(self, coro):
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _finish(self, call_id, cost_usd):
        """Settles this replica's hold for the call once: to its cost, or to the whole hold when cost_usd is None. A cost after an attempt that timed out
        (and may have been billed) is charged with the whole hold on top."""
        state = self._calls.pop(call_id, None)
        if state is None:
            return
        cost = None if cost_usd is None else max(0, _micros_up(cost_usd)) + (state["worst"] if state["timed_out"] else 0)
        try:
            await _LEDGER.settle(call_id, cost)
        except Exception as e:
            # The hold stays and becomes spent when it expires: never less than the call cost.
            print(f"rovara_guard: budget settle failed for a call ({type(e).__name__}); its hold is charged when it expires", file=sys.stderr, flush=True)

    async def _charge_later(self, call_id):
        await asyncio.sleep(SETTLE_GRACE_SECONDS)
        await self._finish(call_id, None)

    async def _hold(self, route, user_api_key_dict, data):
        cap = getattr(user_api_key_dict, "max_budget", None)
        key = getattr(user_api_key_dict, "token", None)
        if cap is None or not isinstance(key, str) or not key:
            return                                          # no budget on this key: nothing to hold
        now = _time.monotonic()
        for stale in [c for c, s in self._calls.items() if now - s["at"] > HOLD_SECONDS + SETTLE_GRACE_SECONDS]:
            self._calls.pop(stale, None)                    # its hold has expired into spend in the ledger
        prices = _prices_for(data.get("model"))
        if prices is None:
            raise _proxy_error(route, 403, "model_not_priced", "this model has no price, so the task budget cannot be held")
        worst = _worst_case_micros(data, prices)
        spent = _micros_up(getattr(user_api_key_dict, "spend", 0) or 0)
        limit = int(math.floor(float(cap) * _MICROS + 1e-6))
        call_id = data.get("litellm_call_id")
        if not isinstance(call_id, str) or not call_id:
            call_id = data["litellm_call_id"] = str(_uuid.uuid4())
        try:
            verdict, charged = await _LEDGER.take(key, call_id, worst, spent, limit)
        except Exception as e:
            print(f"rovara_guard: budget hold failed ({type(e).__name__}); the call is refused", file=sys.stderr, flush=True)
            raise _proxy_error(route, 503, "budget_unavailable", "the task budget could not be checked; try again shortly")
        if verdict == "exceeded":
            asked = max([int(v) for v in (data.get("max_tokens"), data.get("max_output_tokens"), data.get("max_completion_tokens"))
                         if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0] or [0])
            fits = _affordable_output(data, prices, limit - max(charged or 0, spent))
            if fits is not None and (asked == 0 or fits < asked):
                # The room left cannot pay for the output limit asked, but can for a smaller one: say which, so the worker sends the call again with it
                # instead of ending the task while the budget still has room for useful work.
                raise _proxy_error(route, 422, "budget_max_tokens", f"the task budget left pays for at most {fits} output tokens on this call; send it again with that limit",
                                   {MAX_TOKENS_HINT_HEADER: str(fits)})
            # The shape the worker reads as "the task's budget is spent" (model-runtime budget.ts): 422, budget_exceeded, "Budget has been exceeded! Key=".
            raise _proxy_error(route, 422, "budget_exceeded", f"Budget has been exceeded! Key=task Max budget: {limit / _MICROS:.6f}, "
                               f"this call could cost up to {worst / _MICROS:.6f}")
        if verdict == "held":
            raise _proxy_error(route, 429, "budget_held", "other model calls of this task hold its budget for now; try again shortly",
                               {"retry-after": str(HELD_RETRY_AFTER_SECONDS)})
        self._calls[call_id] = {"stream": data.get("stream") is True, "started": False, "ended": None, "cost": None, "at": now, "worst": worst, "timed_out": False, "failed": False}


    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        route = CALL_TYPES.get(str(call_type))
        if route is None:
            _refuse(f"call type {call_type} is not served")
        allowed = ROUTE_FIELDS[route]
        original = (data.get("proxy_server_request") or {})
        body = data
        headers = {str(k).lower(): v for k, v in (original.get("headers") or {}).items()}
        for name in headers:
            if name.startswith("x-litellm-") or name in BANNED_HEADERS:
                _refuse(f"header {name}")
        beta = headers.get("anthropic-beta")
        if beta and not set(b.strip() for b in beta.split(",")) <= ALLOWED_BETAS:
            _refuse("header anthropic-beta value")
        # fallbacks first, so the message names the carrier even though the field is also not in the allow-list
        for name in FALLBACK_FIELDS:
            if name in body:
                found = _deep_names(body[name])
                _refuse(f"{name}" + (f" (carries {found[0]})" if found else ""))
        for name in data:
            if name in INJECTED_TOP or name in allowed:
                continue
            if name in ("metadata", "litellm_metadata"):
                continue                                    # checked below
            _refuse(f"field {name}")
        injected = "metadata" if route == "acompletion" else "litellm_metadata"
        for name in ("metadata", "litellm_metadata"):
            value = data.get(name)
            if value is None:
                continue
            if name == injected:
                extra = sorted(k for k in value if k not in INJECTED_METADATA_KEYS and not str(k).startswith("user_api_key"))
                if extra:
                    _refuse(f"{name}.{extra[0]}")
            elif route == "anthropic_messages" and name == "metadata":
                if not isinstance(value, dict) or set(value) - {"user_id"}:
                    _refuse("metadata")
            else:
                _refuse(f"field {name}")
        _check_tools(route, data.get("tools"))
        _check_nested_tools(route, data)
        if route == "aresponses":
            _check_include(data.get("include"))
        _check_tool_choice(data.get("tool_choice"))
        if route == "acompletion" and "provider" in data:
            p = data["provider"]
            if not isinstance(p, dict) or set(p) - OPENROUTER_PROVIDER_KEYS or p.get("allow_fallbacks") is not False:
                _refuse("provider routing (allow_fallbacks must be false)")
        await self._hold(route, user_api_key_dict, data)          # last: a refused request holds nothing
        return data

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        """Every streamed answer passes through here. A stream that ends cleanly is settled by its cost (async_log_success_event); one that is cut
        (the worker closed it, the provider broke it, the time ran out) is charged its whole hold, whatever partial cost LiteLLM logs for it."""
        call_id = request_data.get("litellm_call_id") if isinstance(request_data, dict) else None
        state = self._calls.get(call_id)
        if state is None:
            async for chunk in response:
                yield chunk
            return
        state["started"] = True
        clean = False
        try:
            async for chunk in response:
                yield chunk
            clean = True
        finally:
            if not clean:
                self._spawn(self._finish(call_id, None))
            elif state["cost"] is not None:
                self._spawn(self._finish(call_id, state["cost"]))
            else:
                state["ended"] = "ok"
                self._spawn(self._charge_later(call_id))

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        call_id = data.get("litellm_call_id") if isinstance(data, dict) else None
        state = self._calls.get(call_id)
        if state is not None and not state["stream"]:
            self._spawn(self._charge_later(call_id))         # the answer is out: its cost must arrive within the grace, or the whole hold is spent
        return response

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        call_id = kwargs.get("litellm_call_id")
        state = self._calls.get(call_id)
        if state is None:
            return
        cost = kwargs.get("response_cost")
        cost = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
        if state["stream"] and state["started"] and state["ended"] is None:
            state["cost"] = cost if cost is not None else state["cost"]    # the stream is still open (or not yet seen): it settles when it ends
            return
        await self._finish(call_id, cost)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        """One ATTEMPT failed. LiteLLM may still retry under the same call id, so nothing is settled here: only whether an attempt timed out is noted."""
        call_id = kwargs.get("litellm_call_id")
        state = self._calls.get(call_id)
        if state is None:
            return
        if _timed_out(kwargs.get("exception")):
            state["timed_out"] = True
        if not state["failed"]:
            state["failed"] = True
            self._spawn(self._settle_failed_later(call_id))

    async def _settle_failed_later(self, call_id):
        """A failed attempt whose call never reaches async_post_call_failure_hook (nor a success): settled after the grace as that hook would settle it,
        released for an error answer, charged in full when an attempt timed out, instead of being held until it expires."""
        await asyncio.sleep(SETTLE_GRACE_SECONDS)
        state = self._calls.get(call_id)
        if state is not None and not state["started"]:
            await self._finish(call_id, None if state["timed_out"] else 0)

    async def async_post_call_failure_hook(self, request_data, original_exception, user_api_key_dict, traceback_str=None):
        """The CALL failed (every attempt). An error answer is not billed and is released; a call one of whose attempts timed out is charged its hold."""
        call_id = request_data.get("litellm_call_id") if isinstance(request_data, dict) else None
        state = self._calls.get(call_id)
        if state is None or state["started"]:
            return                                          # a stream that had begun answering is settled by its wrapper
        await self._finish(call_id, None if state["timed_out"] or _timed_out(original_exception) else 0)


proxy_handler_instance = RovaraGuard()
