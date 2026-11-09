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
# code_execution_*, computer_*, bash_*, text_editor_*, memory_*, tool_search_*, mcp_toolset, ...) is run or defined by the provider.
# OpenAI chat and Responses: "function" only (refuses mcp, web_search*, code_interpreter, file_search, image_generation, computer_use*,
# local_shell, custom, tool_search, namespace, ...).
ROUTE_TOOL_TYPES = {"anthropic_messages": {None, "custom"}, "aresponses": {"function"}, "acompletion": {"function"}}
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


def _check_tools(route, tools):
    """Refuse any tool that is not a plain function (client-side) tool; the message names the offending type."""
    if tools is None:
        return
    if not isinstance(tools, list):
        _refuse("field tools (must be a list of function tools)")
    allowed = ROUTE_TOOL_TYPES[route]
    for i, tool in enumerate(tools):
        if not isinstance(tool, dict):
            _refuse(f"tools[{i}] is not a function tool")
        kind = tool.get("type")
        if (kind is not None and not isinstance(kind, str)) or kind not in allowed:
            shown = kind[:64] if isinstance(kind, str) else type(kind).__name__
            _refuse(f"tool type {shown!r} at tools[{i}] (only function tools are served: provider-side tools such as web search, code execution, MCP, computer use and file search are refused)")


def _check_tool_choice(choice):
    """A tool_choice may name a function, never a provider-side tool type."""
    if choice is None or isinstance(choice, str):
        return
    if not isinstance(choice, dict) or choice.get("type") not in TOOL_CHOICE_TYPES:
        shown = choice.get("type") if isinstance(choice, dict) and isinstance(choice.get("type"), str) else "unknown"
        _refuse(f"tool_choice type {shown[:64]!r} (only auto, any, none, required, tool and function are served)")


class RovaraGuard(CustomLogger):
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
        _check_tool_choice(data.get("tool_choice"))
        if route == "acompletion" and "provider" in data:
            p = data["provider"]
            if not isinstance(p, dict) or set(p) - OPENROUTER_PROVIDER_KEYS or p.get("allow_fallbacks") is not False:
                _refuse("provider routing (allow_fallbacks must be false)")
        return data


proxy_handler_instance = RovaraGuard()
`;
