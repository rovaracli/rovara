// The LiteLLM callback module that gates every company-key request (Plan 3 Task 25). It is the file verified in the model sources
// spike (docs/learnings/model-sources-spike/rovara_guard.py, questions 8 and 9), carried as text so the stack can write it next to
// the proxy's config at start. tests/contract/rovara-guard.test.ts keeps the two identical; on a LiteLLM or Pi bump re-run the
// spike's harness (run-notes.sh) and update both together.
export const ROVARA_GUARD_PY = String.raw`"""Rovara proxy guard: loaded by LiteLLM as a callback module (litellm_settings.callbacks: rovara_guard.proxy_handler_instance).

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
   No model is refused for lack of a price (DECISIONS 172): a model with no known price is held at a cautious estimate (the dearest known
   rate of its provider, times CAUTION_FACTOR) and settled at the dearest known rate, flagged estimated, never at $0. Its worst case is a guess,
   so it never refuses a call the task could still afford one call of (DECISIONS 165): it goes ahead once while the key has not overrun, and
   every call after the overrun is refused. An overrun call whose cost never becomes known is charged its worst case, not the room it held (money review M1), and
   the company's month has a say too (DECISIONS 180): an estimated call that could pass the month's cap takes the month's single slot (one row per company and month),
   and none goes over a key's cap once the month is at its cap. Prices are refreshed
   daily from AWS's public Price List files and LiteLLM's upstream cost map (validated; it may only fill in or raise a price, never lower one or replace a verified override;
   the image's bundled map is the fallback).
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
import asyncio, json, math, os, re, sys, time as _time, urllib.request, uuid as _uuid

HOLD_SECONDS = 1000                 # longer than the proxy's 900 s REQUEST_TIMEOUT: an older hold is an orphan (its replica died) and counts as spent
SETTLE_GRACE_SECONDS = 60           # a call that ended but whose cost never arrived is charged its whole hold after this long
HELD_RETRY_AFTER_SECONDS = 2
MIN_AFFORDABLE_OUTPUT_TOKENS = 4_096  # below this a smaller output limit is not offered: the spend leaves no room for a useful call (422)
MAX_TOKENS_HINT_HEADER = "x-rovara-max-tokens"
ASSUMED_MAX_OUTPUT_TOKENS = 64_000  # a request that names no output limit, for a model whose limit is not known (as the Code proxy assumes)
ASSUMED_MAX_INPUT_TOKENS = 2_000_000
CAUTION_FACTOR = 1.5                # a model with no known price is held at its family's dearest known rate times this
CAUTIOUS_FLOOR_PER_TOKEN = (0.00006, 0.00024)   # (input, output) when not one model of the cost map says anything about the family: $60 and $240 per million
PRICE_REFRESH_ENABLED = os.environ.get("ROVARA_PRICE_REFRESH") != "0"
PRICE_REFRESH_SECONDS = 24 * 3600
PRICE_RETRY_SECONDS = 3600
PRICE_FETCH_TIMEOUT_SECONDS = 20
PRICE_FILE_MAX_BYTES = 64_000_000   # AWS's price list for one region
LITELLM_MAP_MAX_BYTES = 16_000_000  # LiteLLM's cost map is a few MB
PRICE_FETCH_DEADLINE_SECONDS = 60   # the whole read of one price file, however slowly it arrives
MIN_MAP_MODELS = 500                # an upstream cost map with fewer models than this is not the cost map
LONG_CONTEXT_ABOVE_TOKENS = 100_000  # AWS's price list names a long-context tier but not its size; the Pi catalog and pi.dev give 100,000 for Haiku 5.5
AWS_PRICE_URL = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/{region}/index.json"
LITELLM_COST_MAP_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
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
    # How much of what a key was charged is an estimate (a model with no known price, a cut call's whole hold): shown as "estimated" wherever the cost is.
    "ALTER TABLE rovara_budget.keys ADD COLUMN IF NOT EXISTS estimated_micros bigint NOT NULL DEFAULT 0",
    # The worst case of the call a hold is for. An overrun call (DECISIONS 165) holds only the room that is left, so a call cut before its cost is known would be charged
    # that small room; it is charged the worst case instead (never less than the hold). Nullable and additive: a hold written without it (an older guard replica) is charged
    # its reserved amount, as before.
    "ALTER TABLE rovara_budget.holds ADD COLUMN IF NOT EXISTS worst_micros bigint",
    # The company's month as a ledger (DECISIONS 180): what its calls hold and were charged, and whether its one overrun call has been let through. A hold knows its company,
    # month and whether it took the month's slot. All additive; a guard that does not know them still works.
    "CREATE TABLE IF NOT EXISTS rovara_budget.org_months (org text NOT NULL, month text NOT NULL, over_used boolean NOT NULL DEFAULT false,"
    " updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org, month))",
    "ALTER TABLE rovara_budget.org_months ADD COLUMN IF NOT EXISTS held_micros bigint NOT NULL DEFAULT 0",
    "ALTER TABLE rovara_budget.org_months ADD COLUMN IF NOT EXISTS charged_micros bigint NOT NULL DEFAULT 0",
    "ALTER TABLE rovara_budget.holds ADD COLUMN IF NOT EXISTS org text",
    "ALTER TABLE rovara_budget.holds ADD COLUMN IF NOT EXISTS month text",
    "ALTER TABLE rovara_budget.holds ADD COLUMN IF NOT EXISTS slot boolean",
    "ALTER TABLE rovara_budget.holds ADD COLUMN IF NOT EXISTS month_cap bigint",
)
# An orphan (older than HOLD_SECONDS) leaves the holds and is added to what its key and its company's month have been charged: the worst case of its call when that is more than the
# room it held (an overrun call), else what it held. One statement per sweep: a hold is moved once. What leaves "held" is what was reserved (key) or the worst case (month). A swept slot is
# given back unless the month really went over its cap (what it was charged, with this charge, is more than the cap).
_SQL_OWED = "GREATEST(reserved_micros, COALESCE(worst_micros, reserved_micros))"
_SQL_SWEEP = (
    "WITH gone AS (DELETE FROM rovara_budget.holds WHERE key_hash = $1::text AND expires_at < now() RETURNING reserved_micros, worst_micros, org, month, slot, month_cap),"
    f" s AS (SELECT COALESCE(SUM(reserved_micros), 0)::bigint AS n, COALESCE(SUM({_SQL_OWED}), 0)::bigint AS owed FROM gone),"
    " k AS (UPDATE rovara_budget.keys k SET charged_micros = k.charged_micros + s.owed, held_micros = k.held_micros - s.n, updated_at = now()"
    " FROM s WHERE k.key_hash = $1::text AND s.n > 0 RETURNING 1 AS ok),"
    f" mm AS (SELECT org, month, SUM(COALESCE(worst_micros, reserved_micros))::bigint AS w, SUM({_SQL_OWED})::bigint AS owed, COALESCE(bool_or(slot), false) AS slot, MAX(month_cap) AS cap"
    " FROM gone WHERE org IS NOT NULL GROUP BY org, month)"
    " UPDATE rovara_budget.org_months o SET held_micros = o.held_micros - mm.w, charged_micros = o.charged_micros + mm.owed,"
    " over_used = o.over_used AND NOT (mm.slot AND o.charged_micros + mm.owed <= COALESCE(mm.cap, -1)), updated_at = now()"
    " FROM mm, (SELECT count(*) AS n FROM k) kk WHERE o.org = mm.org AND o.month = mm.month")
_SQL_SWEEP_ALL = (
    "WITH gone AS (DELETE FROM rovara_budget.holds WHERE expires_at < now() RETURNING key_hash, reserved_micros, worst_micros, org, month, slot, month_cap),"
    f" s AS (SELECT key_hash, SUM(reserved_micros)::bigint AS n, SUM({_SQL_OWED})::bigint AS owed FROM gone GROUP BY key_hash),"
    " k AS (UPDATE rovara_budget.keys k SET charged_micros = k.charged_micros + s.owed, held_micros = k.held_micros - s.n, updated_at = now()"
    " FROM s WHERE k.key_hash = s.key_hash RETURNING 1 AS ok),"
    f" mm AS (SELECT org, month, SUM(COALESCE(worst_micros, reserved_micros))::bigint AS w, SUM({_SQL_OWED})::bigint AS owed, COALESCE(bool_or(slot), false) AS slot, MAX(month_cap) AS cap"
    " FROM gone WHERE org IS NOT NULL GROUP BY org, month)"
    " UPDATE rovara_budget.org_months o SET held_micros = o.held_micros - mm.w, charged_micros = o.charged_micros + mm.owed,"
    " over_used = o.over_used AND NOT (mm.slot AND o.charged_micros + mm.owed <= COALESCE(mm.cap, -1)), updated_at = now()"
    " FROM mm, (SELECT count(*) AS n FROM k) kk WHERE o.org = mm.org AND o.month = mm.month")
_SQL_FORGET = "DELETE FROM rovara_budget.keys WHERE held_micros = 0 AND updated_at < now() - interval '45 days'"
_SQL_FORGET_MONTHS = "DELETE FROM rovara_budget.org_months WHERE held_micros = 0 AND updated_at < now() - interval '120 days'"
_SQL_ENSURE = "INSERT INTO rovara_budget.keys (key_hash) VALUES ($1::text) ON CONFLICT (key_hash) DO NOTHING"
_SQL_ENSURE_MONTH = "INSERT INTO rovara_budget.org_months (org, month) VALUES ($1::text, $2::text) ON CONFLICT (org, month) DO NOTHING"
# The take: the key's row is locked (FOR UPDATE), then the company's month row (always in that order), so two replicas taking at once are serialised and the second sees the first's hold.
# $7 is an ESTIMATED hold (a model with no known price; its worst case is a guess): when it does not fit the room it goes ahead anyway, once, while the key has not overrun its budget
# and nothing else is held (DECISIONS 165), and it holds only the room that is left. After that call settles over the cap, every take is refused.
# DECISIONS 180: $8 company, $9 month 'YYYY-MM', $10 the month's cap, $11 LiteLLM's spend for it (NULL company: no month). Every call adds its worst case to the month's held. The month
# used is GREATEST(charged, $11) + held. An estimated call whose worst case fits what is left of the month needs nothing; one that could pass the month's cap, whether it fits its key
# or overruns it, goes ahead only by taking the month's single slot (over_used), and none goes ahead once the month is used up.
_SQL_TAKE = (
    "WITH q AS (SELECT key_hash,"
    " (GREATEST(charged_micros, $3::bigint) + held_micros + $2::bigint <= $4::bigint) AS fits,"
    " ($7::boolean AND GREATEST(charged_micros, $3::bigint) < $4::bigint AND held_micros = 0) AS overrun,"
    " LEAST($2::bigint, GREATEST($4::bigint - GREATEST(charged_micros, $3::bigint), 0)) AS room"
    " FROM rovara_budget.keys WHERE key_hash = $1::text FOR UPDATE),"
    " m AS (SELECT GREATEST(charged_micros, $11::bigint) + held_micros AS used, over_used FROM rovara_budget.org_months"
    " WHERE org = $8::text AND month = $9::text AND EXISTS (SELECT 1 FROM q) FOR UPDATE),"
    " g AS (SELECT q.key_hash, q.fits, q.overrun, q.room,"
    " ($8::text IS NOT NULL AND $7::boolean AND COALESCE(m.used, 0) >= $10::bigint) AS blocked,"
    " ($8::text IS NOT NULL AND $7::boolean AND COALESCE(m.used, 0) + $2::bigint > $10::bigint) AS needs_slot,"
    " COALESCE(m.over_used, false) AS slot_taken FROM q LEFT JOIN m ON true),"
    " k AS (UPDATE rovara_budget.keys t SET held_micros = t.held_micros + CASE WHEN g.fits THEN $2::bigint ELSE g.room END, updated_at = now()"
    " FROM g WHERE t.key_hash = g.key_hash AND (g.fits OR g.overrun) AND NOT g.blocked AND NOT (g.needs_slot AND g.slot_taken)"
    " RETURNING t.key_hash, CASE WHEN g.fits THEN $2::bigint ELSE g.room END AS reserved, g.needs_slot),"
    " o AS (UPDATE rovara_budget.org_months o SET held_micros = o.held_micros + $2::bigint, over_used = o.over_used OR k.needs_slot, updated_at = now()"
    " FROM k WHERE o.org = $8::text AND o.month = $9::text RETURNING 1 AS ok)"
    " INSERT INTO rovara_budget.holds (call_id, key_hash, reserved_micros, worst_micros, org, month, slot, month_cap, expires_at)"
    " SELECT $5::text, key_hash, reserved, $2::bigint, $8::text, $9::text, needs_slot, $10::bigint, now() + make_interval(secs => $6::int) FROM k RETURNING call_id")
_SQL_READ = "SELECT charged_micros, held_micros FROM rovara_budget.keys WHERE key_hash = $1::text"
_SQL_MONTH_READ = ("SELECT charged_micros, held_micros, over_used, (SELECT count(*) FROM rovara_budget.holds h WHERE h.org = $1::text AND h.month = $2::text AND h.slot) AS slots"
                   " FROM rovara_budget.org_months WHERE org = $1::text AND month = $2::text")
# Settle: the hold leaves and its key is charged the call's cost ($2), or the whole worst case when $2 is negative (the room it held, or the call's worst case when that is more:
# an overrun call), and $3 says the charge is an estimate. The company's month moves the call's worst case from held to charged, and takes its slot back when the call that held
# it cost little: it is given back unless the month really went over its cap (charged, with this call's cost, more than the cap). Settling twice charges once.
_SQL_SETTLE = (
    "WITH h AS (DELETE FROM rovara_budget.holds WHERE call_id = $1::text RETURNING key_hash, reserved_micros, worst_micros, org, month, slot, month_cap),"
    f" c AS (SELECT key_hash, reserved_micros, COALESCE(worst_micros, reserved_micros) AS worst, org, month, slot, month_cap, CASE WHEN $2::bigint < 0 THEN {_SQL_OWED} ELSE $2::bigint END AS cost FROM h),"
    " k AS (UPDATE rovara_budget.keys k SET held_micros = k.held_micros - c.reserved_micros, charged_micros = k.charged_micros + c.cost,"
    " estimated_micros = k.estimated_micros + CASE WHEN $3::boolean THEN c.cost ELSE 0 END, updated_at = now()"
    " FROM c WHERE k.key_hash = c.key_hash RETURNING k.charged_micros, k.key_hash, k.estimated_micros),"
    " o AS (UPDATE rovara_budget.org_months o SET held_micros = o.held_micros - c.worst, charged_micros = o.charged_micros + c.cost,"
    " over_used = o.over_used AND NOT (COALESCE(c.slot, false) AND o.charged_micros + c.cost <= COALESCE(c.month_cap, -1)), updated_at = now()"
    " FROM c, (SELECT count(*) AS n FROM k) kk WHERE c.org IS NOT NULL AND o.org = c.org AND o.month = c.month RETURNING 1 AS ok)"
    " SELECT charged_micros, key_hash, estimated_micros FROM k")
# The broker reads a key's spend through LiteLLM's /key/info only, so the estimated part of it travels there, in the key's metadata (monotonic: the largest value wins, whichever
# replica stamps last). Only ever stamped when a charge was an estimate.
_SQL_STAMP = (
    "UPDATE \"LiteLLM_VerificationToken\" SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('rovara_estimated_micros', $2::bigint)"
    " WHERE token = $1::text AND COALESCE((metadata->>'rovara_estimated_micros')::bigint, -1) < $2::bigint")


async def _retrying(call):
    """Runs a database call, once more when Postgres picked it as the victim of a deadlock (40P01): the ledger's statements lock a key row and then a month row, but two sweeps can meet."""
    try:
        return await call()
    except Exception as e:
        if "40P01" in str(e) or "deadlock detected" in str(e):
            return await call()
        raise


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
                    await _retrying(lambda: db.execute_raw(_SQL_SWEEP_ALL))
                    await db.execute_raw(_SQL_FORGET)
                    await db.execute_raw(_SQL_FORGET_MONTHS)
                    self._ready = True
        return db

    async def take(self, key, call_id, worst, spent, cap, estimated=False, month_gate=None):
        """('ok' | 'exceeded' | 'held' | 'month' | 'slot', micros): held; the spend leaves no room for this call; only other calls' holds are in the way; the company's month is used up
        (DECISIONS 180); the call could pass the month's cap and its one slot is taken (then the micros are the month's room left). month_gate: (company, 'YYYY-MM', cap, spend) or None."""
        db = await self._db()
        org, month, month_cap, month_spent = month_gate or (None, None, 1 << 62, 0)
        try:
            await db.execute_raw(_SQL_ENSURE, key)
            if org is not None:
                await db.execute_raw(_SQL_ENSURE_MONTH, org, month)
            await _retrying(lambda: db.execute_raw(_SQL_SWEEP, key))
            if await _retrying(lambda: db.query_raw(_SQL_TAKE, key, worst, spent, cap, call_id, HOLD_SECONDS, bool(estimated), org, month, month_cap, month_spent)):
                return "ok", None
            rows = await db.query_raw(_SQL_READ, key)
            months = await db.query_raw(_SQL_MONTH_READ, org, month) if estimated and org is not None else []
        except Exception:
            self._ready = False                             # the tables are created again on the next call if they went
            raise
        charged = int(rows[0]["charged_micros"]) if rows else 0
        if months:
            settled = max(int(months[0]["charged_micros"]), month_spent)
            used = settled + int(months[0]["held_micros"])
            if settled >= month_cap:
                return "month", settled                     # the month's spend itself is at its cap: the only answer that ends the task
            if used >= month_cap:
                return "held", charged                      # only calls in flight fill the month: try again when they settle
            if used + worst > month_cap and str(months[0]["over_used"]).lower() in ("true", "t", "1"):
                if int(months[0]["slots"]) > 0:
                    return "held", charged                  # the call that took the slot is still in flight
                return "slot", min(month_cap - used, cap - max(charged, spent))
        charged = int(rows[0]["charged_micros"]) if rows else 0
        return ("exceeded" if max(charged, spent) + worst > cap else "held"), charged

    async def settle(self, call_id, cost, estimated=False):
        """Ends a hold: its key is charged cost micro-dollars, or the whole worst case of the call when cost is None; 'estimated' adds the charge to what is shown as estimated."""
        db = await self._db()
        try:
            rows = await _retrying(lambda: db.query_raw(_SQL_SETTLE, call_id, -1 if cost is None else cost, bool(estimated)))
        except Exception:
            self._ready = False
            raise
        if estimated and rows:
            try:
                await db.execute_raw(_SQL_STAMP, rows[0]["key_hash"], int(rows[0]["estimated_micros"]))
            except Exception as e:
                print(f"rovara_guard: could not stamp a key's estimated spend ({type(e).__name__})", file=sys.stderr, flush=True)


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


_ESTIMATED = {}                     # cost-map key -> alias, for each key this guard filled with an estimate (never read back as a known price)
_CAUTION_CACHE = {}


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _stripped(model):
    return model.split("/", 1)[-1]


def _deployments_of(alias):
    from litellm.proxy.proxy_server import llm_router
    return (llm_router.get_model_list(model_name=alias) if llm_router is not None and isinstance(alias, str) else None) or []


def _prices_for(alias):
    """The dearest price of every deployment serving this model name: the deployment's own prices (a company source's) and LiteLLM's cost map
    (the image's, as the daily refresh has updated it). None when the name has no deployment or no positive input and output price: an estimate
    this guard put in the cost map for a model with no price is not a price."""
    import litellm
    found = None
    for deployment in _deployments_of(alias):
        params = dict(deployment.get("litellm_params") or {})
        entries = [params, dict(deployment.get("model_info") or {})]
        model = params.get("model")
        if isinstance(model, str) and model not in _ESTIMATED and _stripped(model) not in _ESTIMATED:
            try: entries.append(dict(litellm.get_model_info(model=model) or {}))
            except Exception: pass
            mapped = litellm.model_cost.get(model) or litellm.model_cost.get(_stripped(model))
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


_PROVIDER_OF_NAME = (
    (re.compile(r"^(?:gpt-|chatgpt|o\d|codex|text-embedding)"), "openai"), (re.compile(r"^gemini"), "gemini"), (re.compile(r"^grok"), "xai"),
    (re.compile(r"^(?:mistral|mixtral|codestral|pixtral|ministral)"), "mistral"), (re.compile(r"^(?:command|cohere)"), "cohere"), (re.compile(r"^deepseek"), "deepseek"),
)


def _model_label(deployment):
    """A deployment's model as LiteLLM names it, with its provider in front when only custom_llm_provider says it."""
    params = (deployment or {}).get("litellm_params") or {}
    model, provider = params.get("model"), params.get("custom_llm_provider")
    if isinstance(model, str) and "/" not in model and isinstance(provider, str) and provider:
        return f"{provider}/{model}"
    return model if isinstance(model, str) else None


def _family_of(model):
    """What a model is compared with when it has no price: Claude (whoever serves it); else the provider it names (bedrock/, openai/, azure/, gemini/, vertex_ai/,
    openrouter/ ... in front of its id, or what a bare name like gpt-5 or gemini-2 says); only a truly unknown provider is compared with every model."""
    text = (model or "").lower()
    if "claude" in text or "anthropic" in text:
        return ("claude", None)
    if "/" in text:
        return ("provider", text.split("/", 1)[0])
    for pattern, provider in _PROVIDER_OF_NAME:
        if pattern.match(text):
            return ("provider", provider)
    return ("any", None)


def _same_provider(entry_provider, provider):
    return isinstance(entry_provider, str) and (entry_provider == provider or entry_provider.startswith(provider + "-") or entry_provider.startswith(provider + "_"))


def _dearest_known(model):
    """(input rate, output rate, fixed price per call) of the dearest chat model of the family in the cost map, long-context tiers and cache writes included:
    the same provider's when the provider is known, every model's only for an unknown provider. Never a key this guard filled with an estimate."""
    import litellm
    family = _family_of(model)
    if family in _CAUTION_CACHE:
        return _CAUTION_CACHE[family]
    kind, provider = family
    best = (0.0, 0.0, 0.0)
    for key, entry in list(litellm.model_cost.items()):
        if key == "sample_spec" or not isinstance(entry, dict) or key in _ESTIMATED or _stripped(key) in _ESTIMATED:
            continue
        if entry.get("mode") not in (None, "chat", "completion", "responses"):
            continue
        if kind == "claude" and "claude" not in key.lower():
            continue
        if kind == "provider" and not _same_provider(entry.get("litellm_provider"), provider):
            continue
        rate_in, rate_out, _o, _i, per_call = _rates([entry])
        best = (max(best[0], rate_in), max(best[1], rate_out), max(best[2], per_call))
    if best[0] <= 0 or best[1] <= 0:
        if kind != "any":
            return _dearest_known(None)                     # nothing priced is known of this family: the dearest of any
        best = (max(best[0], CAUTIOUS_FLOOR_PER_TOKEN[0]), max(best[1], CAUTIOUS_FLOOR_PER_TOKEN[1]), best[2])
    _CAUTION_CACHE[family] = best
    return best


def _register_estimate(alias, rates):
    """Puts the dearest known rate in the cost map for each deployment of the alias, so LiteLLM settles the call (and the key's spend) at an estimate, not
    at $0. The key stays listed in _ESTIMATED until a real price replaces it."""
    import litellm
    rate_in, rate_out, per_call = rates
    for deployment in _deployments_of(alias):
        model = (deployment.get("litellm_params") or {}).get("model")
        if not isinstance(model, str):
            continue
        record = {"litellm_provider": model.split("/", 1)[0] if "/" in model else (deployment.get("litellm_params") or {}).get("custom_llm_provider") or "openai", "mode": "chat", "input_cost_per_token": rate_in, "output_cost_per_token": rate_out,
                  "cache_read_input_token_cost": rate_in, "cache_creation_input_token_cost": rate_in}   # cached tokens too: left out, LiteLLM counts them as free
        if per_call > 0:
            record["input_cost_per_request"] = per_call
        keys = {model, _stripped(model)}
        for key in keys:
            _ESTIMATED[key] = alias
        try: litellm.register_model({key: dict(record) for key in keys})
        except Exception as e: print(f"rovara_guard: could not register an estimated price for a model ({type(e).__name__})", file=sys.stderr, flush=True)
        print(f"rovara_guard: model {alias} has no known price: held at {CAUTION_FACTOR}x and settled at the dearest known rate of its family, flagged estimated", file=sys.stderr, flush=True)


def _hold_prices(alias):
    """((input rate, output rate, max output, max input, per call), estimated) for the hold. A model with no known price is never refused: its hold
    is the family's dearest known rate times CAUTION_FACTOR, and its settlement, flagged estimated, is that dearest known rate (below)."""
    known = _prices_for(alias)
    if known is not None:
        return known, False
    rate_in, rate_out, per_call = _dearest_known(next((_model_label(d) for d in _deployments_of(alias)), None) or alias)
    if _deployments_of(alias) and not any(_stripped(d.get("litellm_params", {}).get("model", "")) in _ESTIMATED for d in _deployments_of(alias)):
        _register_estimate(alias, (rate_in, rate_out, per_call))
    return (rate_in * CAUTION_FACTOR, rate_out * CAUTION_FACTOR, None, None, per_call * CAUTION_FACTOR), True


def _usage_tokens(kwargs, response_obj):
    """(input tokens, output tokens, cache read tokens, cache write tokens) the provider reported for the call, or None when it reported none."""
    usage = getattr(response_obj, "usage", None)
    if usage is None and isinstance(response_obj, dict):
        usage = response_obj.get("usage")
    if usage is None:
        logged = kwargs.get("standard_logging_object") if isinstance(kwargs, dict) else None
        usage = logged if isinstance(logged, dict) else None
    if usage is None:
        return None
    get = (lambda name: usage.get(name)) if isinstance(usage, dict) else (lambda name: getattr(usage, name, None))
    prompt = get("prompt_tokens") if _is_number(get("prompt_tokens")) else get("input_tokens")
    completion = get("completion_tokens") if _is_number(get("completion_tokens")) else get("output_tokens")
    if not _is_number(prompt) and not _is_number(completion):
        return None
    details = get("prompt_tokens_details")
    cached = (details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", None)) if details is not None else None
    read = get("cache_read_input_tokens") if _is_number(get("cache_read_input_tokens")) else cached
    write = get("cache_creation_input_tokens")
    if _is_number(get("prompt_tokens")):
        read = write = 0                                    # LiteLLM's usage (and OpenAI's) counts cached tokens inside prompt_tokens; only Anthropic's own input_tokens leaves them out
    return tuple(int(v) if _is_number(v) and v > 0 else 0 for v in (prompt, completion, read, write))


def _settled_cost(state, cost, tokens, alias):
    """(cost in USD or None for the whole hold, estimated): LiteLLM's cost when it priced the call; otherwise what the provider's reported usage costs at
    the dearest known rate of the model's family, flagged estimated (cache tokens at the input rate); the whole hold, flagged estimated, when the provider reported no usage
    or usage of all zeros. A call that used tokens never settles at $0."""
    if cost is not None and cost > 0:
        return cost, bool(state.get("estimated"))
    if tokens is None:
        return None, True                                   # no usage reported, no cost: the whole hold
    prompt, completion, read, write = tokens
    if prompt + completion + read + write <= 0:
        return None, True                                   # usage of all zeros is no usage: a call that answered is never settled at $0, it is charged the whole hold
    deployment = next(iter(_deployments_of(alias)), None)
    rate_in, rate_out, per_call = _dearest_known(_model_label(deployment) or alias)
    # Cached tokens are charged at the input rate once: read and write are only non-zero when the provider's usage counts them apart from the input tokens.
    return max(prompt, 0) * rate_in + max(completion, 0) * rate_out + (max(read, 0) + max(write, 0)) * rate_in + per_call, True


# ---------------------------------------------------------------- 4a. fresh prices: AWS's price list, LiteLLM's upstream cost map
# Each is fetched at most once a day by every replica, over HTTPS from one fixed host, and only ever fills in or corrects LiteLLM's own cost map in memory (register_model):
# a source that cannot be reached, or whose answer fails its checks, leaves the image's bundled map as it is.
_AWS_USAGE = re.compile(r"_(input|output|cache_read|cache_write)_tokens(_1h)?(_long_ctx)?(_global)?_standard-Units$")
_AWS_FIELDS = {"input": "input_cost_per_token", "output": "output_cost_per_token", "cache_read": "cache_read_input_token_cost", "cache_write": "cache_creation_input_token_cost"}
_VENDOR_PREFIX = re.compile(r"^(?:(?:us-gov|us|eu|apac|global|jp|au|in|ca)\.)?[a-z0-9-]+\.")
_VERSION_SUFFIX = re.compile(r"(?:-\d{8})?(?:-v\d+(?::\d+)?)?$|@\d+$")
_PRICE_STATE = {"aws": None, "litellm": None}
_BUNDLED = {}


def _norm_model_id(model_id):
    """'us.anthropic.claude-haiku-4-5-20251001-v1:0' and AWS's 'Claude Haiku 4.5' both come to 'claude-haiku-4-5'."""
    text = _stripped(model_id).lower()
    text = _VENDOR_PREFIX.sub("", text, count=1) if "." in text else text
    return _VERSION_SUFFIX.sub("", text)


def _parse_aws_offer(offer):
    """{(normalized model, 'global' | 'geo'): LiteLLM-named price record} from an AWS Price List offer file (AmazonBedrockFoundationModels, one region).
    Only standard on-demand token prices: batch, flex and provisioned rows are not in the standard usage types."""
    products = offer.get("products") if isinstance(offer, dict) else None
    terms = ((offer.get("terms") or {}).get("OnDemand") if isinstance(offer, dict) else None) or {}
    if not isinstance(products, dict):
        raise ValueError("the price list has no products")
    out = {}
    for sku, product in products.items():
        attributes = product.get("attributes") or {}
        name, usage = attributes.get("model"), _AWS_USAGE.search(str(attributes.get("usagetype") or ""))
        if not isinstance(name, str) or usage is None:
            continue
        kind, hour, long_ctx, is_global = usage.group(1), usage.group(2), usage.group(3), usage.group(4)
        price = None
        for term in (terms.get(sku) or {}).values():
            for dimension in (term.get("priceDimensions") or {}).values():
                if dimension.get("unit") == "1M tokens":
                    try: price = float((dimension.get("pricePerUnit") or {}).get("USD"))
                    except (TypeError, ValueError): price = None
        if price is None or not math.isfinite(price) or price <= 0 or price > 1000:
            continue
        field = _AWS_FIELDS[kind]
        if hour:
            if kind != "cache_write" or long_ctx:
                continue
            field = "cache_creation_input_token_cost_above_1hr"
        elif long_ctx:
            field = f"{field}_above_{LONG_CONTEXT_ABOVE_TOKENS // 1000}k_tokens"
        record = out.setdefault((re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"), "global" if is_global else "geo"), {})
        record[field] = price / 1e6
    return {key: record for key, record in out.items() if record.get("input_cost_per_token", 0) > 0 and record.get("output_cost_per_token", 0) > 0}


def _aws_region():
    import litellm
    from litellm.proxy.proxy_server import llm_router
    for deployment in (llm_router.get_model_list() if llm_router is not None else None) or []:
        region = (deployment.get("litellm_params") or {}).get("aws_region_name")
        if isinstance(region, str) and re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region):
            return region
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"


def _own_prices(deployment):
    """Whether a deployment carries prices of its own (a company source's): a refresh never replaces those. Rovara's own override (marked in its model_info)
    is a fallback, not a company's price: a refresh from AWS replaces it."""
    if (deployment.get("model_info") or {}).get("rovara_price_override") is True:
        return False
    return any(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for source in (deployment.get("litellm_params") or {}, deployment.get("model_info") or {})
               for k, v in source.items() if k in ("input_cost_per_token", "output_cost_per_token"))


def _price_keys(deployment):
    """Where LiteLLM looks a deployment's price up: its model as configured, the bare id, and the id the router registered the deployment's own prices under."""
    model = (deployment.get("litellm_params") or {}).get("model")
    ident = (deployment.get("model_info") or {}).get("id")
    return [k for k in {model, _stripped(model), ident} if isinstance(k, str) and k]


def _current_entry(deployment):
    import litellm
    merged = {}
    for key in reversed(_price_keys(deployment)):
        merged.update(litellm.model_cost.get(key) or {})
    return merged


def _apply_aws_prices(parsed):
    """Fills in, for each Bedrock deployment, the prices LiteLLM's map lacks, and corrects a base rate that differs from AWS's by more than half a percent
    (a stale bundled map). Tiers come from AWS only for a model whose map entry has none, at LONG_CONTEXT_ABOVE_TOKENS. Returns how many models changed."""
    import litellm
    from litellm.proxy.proxy_server import llm_router
    changed = 0
    for deployment in (llm_router.get_model_list() if llm_router is not None else None) or []:
        model = (deployment.get("litellm_params") or {}).get("model")
        if not isinstance(model, str) or not model.startswith("bedrock/") or _own_prices(deployment):
            continue
        bare = _stripped(model)
        record = parsed.get((_norm_model_id(bare), "global" if bare.startswith("global.") else "geo"))
        if record is None:
            continue
        current = _current_entry(deployment)
        known = model not in _ESTIMATED and bare not in _ESTIMATED and (current.get("input_cost_per_token") or 0) > 0 and (current.get("output_cost_per_token") or 0) > 0
        if known:
            drift = max(abs(current[f] - record[f]) / record[f] for f in ("input_cost_per_token", "output_cost_per_token"))
            if drift <= 0.005:
                continue
            merged = dict(current)
            for field, value in record.items():
                if "_above_" in field and any("_above_" in k and "tokens" in k for k in current):
                    continue
                merged[field] = value
        else:
            merged = {"litellm_provider": "bedrock", "mode": "chat", **record}
        try:
            litellm.register_model({key: dict(merged) for key in _price_keys(deployment)})
        except Exception:
            continue
        for key in _price_keys(deployment):
            _ESTIMATED.pop(key, None)
        changed += 1
    _CAUTION_CACHE.clear()
    return changed


def _validate_cost_map(candidate, bundled):
    """None when an upstream cost map can be trusted, else why not: it must be an object of enough models, with sane per-token prices, and the models
    both maps price must not have moved implausibly (more than 100-fold either way for more than a tenth of them)."""
    if not isinstance(candidate, dict):
        return "not an object"
    entries = {k: v for k, v in candidate.items() if k != "sample_spec" and isinstance(v, dict)}
    if len(entries) < max(MIN_MAP_MODELS, 0.8 * len(bundled)):
        return "too few models"
    bad = 0
    for entry in entries.values():
        for field in ("input_cost_per_token", "output_cost_per_token"):
            value = entry.get(field)
            if value is not None and (not _is_number(value) or value < 0 or value > 0.01):
                bad += 1
    if bad > 0.01 * len(entries):
        return "prices out of range"
    compared = drifted = 0
    for key, (bundled_in, bundled_out) in bundled.items():
        entry = entries.get(key)
        if entry is None:
            continue
        compared += 1
        new_in, new_out = entry.get("input_cost_per_token"), entry.get("output_cost_per_token")
        if not _is_number(new_in) or not _is_number(new_out) or new_in <= 0 or new_out <= 0 or not 0.01 <= new_in / bundled_in <= 100 or not 0.01 <= new_out / bundled_out <= 100:
            drifted += 1
    if compared and drifted > 0.1 * compared:
        return "prices changed implausibly"
    return None


def _bundled_prices():
    import litellm
    if not _BUNDLED:
        for key, entry in litellm.model_cost.items():
            if key != "sample_spec" and isinstance(entry, dict) and _is_number(entry.get("input_cost_per_token")) and _is_number(entry.get("output_cost_per_token")) \
                    and entry["input_cost_per_token"] > 0 and entry["output_cost_per_token"] > 0:
                _BUNDLED[key] = (entry["input_cost_per_token"], entry["output_cost_per_token"])
    return _BUNDLED


def _raise_only(fresh, current):
    """The upstream entry with every cost no lower than the one already known: the upstream map may fill a missing price or raise one, never lower it
    (only AWS's price list, or a verified override, may lower a price)."""
    out = dict(fresh)
    for name, known in (current or {}).items():
        if "cost" in name and _is_number(known) and known > 0 and _is_number(out.get(name)) and out[name] < known:
            out[name] = known
    return out


def _zero_priced(entry):
    """Whether an upstream entry carries a base price that is zero or negative: for a model this proxy serves that is a gap or a free tier, not a price."""
    return any(name in entry and (not _is_number(entry[name]) or entry[name] <= 0) for name in ("input_cost_per_token", "output_cost_per_token"))


def _is_guess(key):
    """Whether the cost map's entry for exactly this key is this guard's own estimate, not a price."""
    return key in _ESTIMATED


def _real_price(entry):
    """An upstream price counts only with both an input and an output cost above zero."""
    return all(_is_number(entry.get(name)) and entry[name] > 0 for name in ("input_cost_per_token", "output_cost_per_token"))


def _apply_cost_map(candidate):
    """Registers a validated upstream cost map, and refreshes the entry LiteLLM's router copied for each deployment (it copies at start, so it would stay stale).
    The upstream map only fills in a missing price or raises one: it never lowers a price, never replaces Rovara's verified override (rovara_price_override), and a price
    of zero for a model this proxy serves is not registered. A deployment with prices of its own, and a model this guard holds an estimate for until a price
    appears, are handled by the same rule as a bundled price."""
    import litellm
    from litellm.proxy.proxy_server import llm_router
    deployments = (llm_router.get_model_list() if llm_router is not None else None) or []
    served, protected, current = set(), set(), []
    for deployment in deployments:
        model = (deployment.get("litellm_params") or {}).get("model")
        if not isinstance(model, str):
            continue
        served |= {model, _stripped(model)}
        if (deployment.get("model_info") or {}).get("rovara_price_override") is True:
            protected |= {model, _stripped(model), *_price_keys(deployment)}
    entries, replaced = {}, set()
    for key, value in candidate.items():
        if key == "sample_spec" or not isinstance(value, dict) or key in protected or (key in served and _zero_priced(value)):
            continue
        if _is_guess(key) and not _real_price(value):
            continue                                         # not a price: the guess stays until a real one comes
        guess = _is_guess(key)
        entries[key] = value if guess else _raise_only(value, litellm.model_cost.get(key))   # a real price replaces the guard's guess, however much lower
        if guess:
            replaced.add(key)
    for deployment in deployments:                           # before the register below changes what the cost map holds
        keys = _price_keys(deployment)
        current.append(None if any(_is_guess(k) for k in keys) else _current_entry(deployment))
    for key in replaced:
        litellm.model_cost.pop(key, None)                    # so none of the guess's cache rates survive the merge
        _ESTIMATED.pop(key, None)
    litellm.register_model(entries)
    for deployment, known in zip(deployments, current):
        model = (deployment.get("litellm_params") or {}).get("model")
        if not isinstance(model, str) or _own_prices(deployment) or model in protected:
            continue
        fresh = entries.get(model) or entries.get(_stripped(model))
        if fresh is not None and _real_price(fresh):
            fresh = _raise_only(fresh, known)
            if known is None:
                for key in _price_keys(deployment):
                    litellm.model_cost.pop(key, None)
            litellm.register_model({key: dict(fresh) for key in _price_keys(deployment)})
            for key in _price_keys(deployment):
                _ESTIMATED.pop(key, None)
    _CAUTION_CACHE.clear()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A price source that answers with a redirect is refused: the fixed host is the only place a price may come from."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("a price source answered with a redirect")


def _fetch_json(url, host, opener=None):
    """One fixed https host (no redirect, and the final address checked), a total deadline for the whole read and a size limit (smaller for LiteLLM's map). Run in a thread (urllib blocks)."""
    if not url.startswith(f"https://{host}/"):
        raise ValueError("not a price source")
    limit = LITELLM_MAP_MAX_BYTES if host == "raw.githubusercontent.com" else PRICE_FILE_MAX_BYTES
    deadline = _time.monotonic() + PRICE_FETCH_DEADLINE_SECONDS
    opener = opener or urllib.request.build_opener(_NoRedirect)
    body = bytearray()
    with opener.open(urllib.request.Request(url, headers={"user-agent": "rovara-price-refresh"}), timeout=PRICE_FETCH_TIMEOUT_SECONDS) as reply:
        if not str(reply.geturl()).startswith(f"https://{host}/"):
            raise ValueError("the price source answered from another address")
        while True:
            chunk = reply.read(65_536)
            if not chunk:
                break
            body += chunk
            if len(body) > limit:
                raise ValueError("the price file is too large")
            if _time.monotonic() > deadline:
                raise ValueError("the price file did not arrive before its deadline")
    return json.loads(bytes(body))


async def _refresh_prices(fetch=None):
    """One refresh of both sources; each fails on its own. Never raises. Returns {'litellm': reason or 'ok', 'aws': reason or 'ok'}."""
    fetch = fetch or _fetch_json
    result = {}
    try:
        candidate = await asyncio.to_thread(fetch, LITELLM_COST_MAP_URL, "raw.githubusercontent.com")
        reason = _validate_cost_map(candidate, _bundled_prices())
        if reason is None:
            _apply_cost_map(candidate)
            _PRICE_STATE["litellm"] = _time.time()
        result["litellm"] = reason or "ok"
    except Exception as e:
        result["litellm"] = type(e).__name__
    try:
        offer = await asyncio.to_thread(fetch, AWS_PRICE_URL.format(region=_aws_region()), "pricing.us-east-1.amazonaws.com")
        parsed = _parse_aws_offer(offer)
        _apply_aws_prices(parsed)
        _PRICE_STATE["aws"] = _time.time()
        result["aws"] = "ok" if parsed else "no prices"
    except Exception as e:
        result["aws"] = type(e).__name__
    print(f"rovara_guard: price refresh: {json.dumps(result)}", file=sys.stderr, flush=True)
    return result


_REFRESHER = [None]


def _ensure_refresher():
    """Starts the daily refresh on the proxy's event loop, once per process."""
    if PRICE_REFRESH_ENABLED and _REFRESHER[0] is None:
        async def loop():
            while True:
                result = await _refresh_prices()
                await asyncio.sleep(PRICE_REFRESH_SECONDS if all(v == "ok" for v in result.values()) else PRICE_RETRY_SECONDS)
        _REFRESHER[0] = asyncio.get_running_loop().create_task(loop())


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


def _month_gate(user_api_key_dict):
    """DECISIONS 180: (company, 'YYYY-MM', the month's cap, LiteLLM's spend for it) for a key of a company, else None. The month is LiteLLM's budget window: its "1mo" reset
    lands on the 1st at 00:00 UTC (no timezone or reset time is configured), the calendar month in UTC. Every call is counted in it; only estimated ones are gated."""
    org = getattr(user_api_key_dict, "team_id", None)
    if not isinstance(org, str) or not org:
        return None
    cap = getattr(user_api_key_dict, "team_max_budget", None)
    month_cap = int(math.floor(float(cap) * _MICROS + 1e-6)) if _is_number(cap) and cap > 0 else 1 << 62
    return org, _time.strftime("%Y-%m", _time.gmtime()), month_cap, _micros_up(getattr(user_api_key_dict, "team_spend", 0) or 0)


class RovaraGuard(CustomLogger):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._calls = {}        # litellm_call_id -> this replica's open holds: {"stream", "started", "ended", "cost", "at", "worst", "timed_out"}
        self._tasks = set()

    def _spawn(self, coro):
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _finish(self, call_id, cost_usd, estimated=False):
        """Settles this replica's hold for the call once: to its cost, or to the whole hold when cost_usd is None (then flagged estimated). A cost after an
        attempt that timed out (and may have been billed) is charged with the whole hold on top. 'estimated': the cost is an estimate, not a price."""
        state = self._calls.pop(call_id, None)
        if state is None:
            return
        cost = None if cost_usd is None else max(0, _micros_up(cost_usd)) + (state["worst"] if state["timed_out"] else 0)
        try:
            await _LEDGER.settle(call_id, cost, True if cost_usd is None else bool(estimated))
        except Exception as e:
            # The hold stays and becomes spent when it expires: never less than the call cost.
            print(f"rovara_guard: budget settle failed for a call ({type(e).__name__}); its hold is charged when it expires", file=sys.stderr, flush=True)

    async def _charge_later(self, call_id):
        await asyncio.sleep(SETTLE_GRACE_SECONDS)
        await self._finish(call_id, None, True)

    async def _hold(self, route, user_api_key_dict, data):
        cap = getattr(user_api_key_dict, "max_budget", None)
        key = getattr(user_api_key_dict, "token", None)
        if cap is None or not isinstance(key, str) or not key:
            return                                          # no budget on this key: nothing to hold
        now = _time.monotonic()
        for stale in [c for c, s in self._calls.items() if now - s["at"] > HOLD_SECONDS + SETTLE_GRACE_SECONDS]:
            self._calls.pop(stale, None)                    # its hold has expired into spend in the ledger
        prices, estimated = _hold_prices(data.get("model"))
        worst = _worst_case_micros(data, prices)
        spent = _micros_up(getattr(user_api_key_dict, "spend", 0) or 0)
        limit = int(math.floor(float(cap) * _MICROS + 1e-6))
        call_id = data.get("litellm_call_id")
        if not isinstance(call_id, str) or not call_id:
            call_id = data["litellm_call_id"] = str(_uuid.uuid4())
        gate = _month_gate(user_api_key_dict)
        try:
            verdict, charged = await _LEDGER.take(key, call_id, worst, spent, limit, estimated, month_gate=gate)
        except Exception as e:
            print(f"rovara_guard: budget hold failed ({type(e).__name__}); the call is refused", file=sys.stderr, flush=True)
            raise _proxy_error(route, 503, "budget_unavailable", "the task budget could not be checked; try again shortly")
        if verdict == "month":
            # DECISIONS 180: the company's month is used up: the shape the worker reads as that (model-runtime budget.ts: Team=).
            raise _proxy_error(route, 422, "budget_exceeded", f"Budget has been exceeded! Team={gate[0]} Max budget: {gate[2] / _MICROS:.6f}, this call could cost up to {worst / _MICROS:.6f}")
        month_room = None
        if verdict == "slot":
            month_room = charged                            # the month's one slot is taken and nothing is in flight: only a smaller output (the room is the least of the key's and the month's) can go on
            fits = _affordable_output(data, prices, month_room)
            asked = max([int(v) for v in (data.get("max_tokens"), data.get("max_output_tokens"), data.get("max_completion_tokens"))
                         if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0] or [0])
            if fits is not None and (asked == 0 or fits < asked):
                raise _proxy_error(route, 422, "budget_max_tokens", f"the budget left pays for at most {fits} output tokens on this call; send it again with that limit",
                                   {MAX_TOKENS_HINT_HEADER: str(fits)})
            verdict = "held"
        if verdict == "exceeded" and estimated and max(charged or 0, spent) < limit:
            verdict = "held"                                # an estimated hold the room cannot take while the task has not overrun: only an earlier call's hold is in the way
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
        self._calls[call_id] = {"stream": data.get("stream") is True, "started": False, "ended": None, "cost": None, "at": now, "worst": worst, "timed_out": False, "failed": False, "estimated": estimated, "model": data.get("model")}


    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        route = CALL_TYPES.get(str(call_type))
        if route is None:
            _refuse(f"call type {call_type} is not served")
        _ensure_refresher()
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
                self._spawn(self._finish(call_id, state["cost"], state.get("cost_estimated", False)))
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
        # LiteLLM prices a call it has no price for at $0: a call that used tokens is never settled at that.
        cost, estimated = _settled_cost(state, cost, _usage_tokens(kwargs, response_obj), state.get("model"))
        if state["stream"] and state["started"] and state["ended"] is None:
            state["cost"] = cost if cost is not None else state["cost"]    # the stream is still open (or not yet seen): it settles when it ends
            state["cost_estimated"] = estimated
            return
        await self._finish(call_id, cost, estimated)

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
`;
