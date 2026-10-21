import json, sys, urllib.request, urllib.error
BASE = sys.argv[1]; KEY = sys.argv[2]; MODELS = dict(zip(["msg", "resp", "cc"], sys.argv[3].split(",")))
ROUTE = {"msg": "/v1/messages?beta=true", "resp": "/v1/responses", "cc": "/chat/completions"}
def post(t, body, headers=None):
    h = {"Authorization": "Bearer " + KEY, "x-api-key": KEY, "Content-Type": "application/json", "anthropic-version": "2023-06-01", **(headers or {})}
    r = urllib.request.Request(BASE + ROUTE[t], data=json.dumps(body).encode(), headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=40); resp.read(); return resp.status, ""
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:140]
cap = json.load(open("pi-direct.json"))["captured"]
route_of = lambda p: "msg" if p.startswith("/v1/messages") else "resp" if p.startswith("/v1/responses") else "cc"
ok = bad = 0
print("== Pi's real bodies (pi-ai 1.0.0, %d requests, model renamed to the alias)" % len(cap))
for c in cap:
    t = route_of(c["path"]); body = {**c["body"], "model": MODELS[t]}
    s, e = post(t, body)
    ok += s == 200; bad += s != 200
    if s != 200: print("  REFUSED", c["scenario"], t, s, e)
print(f"  passed {ok}, refused {bad}")
base = {"msg": {"model": MODELS["msg"], "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]},
        "resp": {"model": MODELS["resp"], "input": "hi"},
        "cc": {"model": MODELS["cc"], "messages": [{"role": "user", "content": "hi"}]}}
cases = [("clean", {}, None),
 ("api_key", {"api_key": "sk-x"}, None), ("extra_headers", {"extra_headers": {"x-a": "1"}}, None),
 ("aws_region_name", {"aws_region_name": "eu-west-1"}, None), ("organization", {"organization": "org-x"}, None), ("service_tier", {"service_tier": "priority"}, None),
 ("models (OpenRouter)", {"models": ["a/b", "c/d"]}, None), ("route (OpenRouter)", {"route": "fallback"}, None),
 ("fallbacks[dict].api_key", {"fallbacks": [{"model": "{M}", "api_key": "sk-x"}]}, None),
 ("fallbacks[dict].extra_headers", {"fallbacks": [{"model": "{M}", "extra_headers": {"Authorization": "Bearer x"}}]}, None),
 ("fallbacks (plain list)", {"fallbacks": [{"{M}": ["{M}"]}]}, None),
 ("context_window_fallbacks", {"context_window_fallbacks": [{"{M}": ["{M}"]}]}, None),
 ("router_settings_override", {"router_settings_override": {"num_retries": 9}}, None),
 ("unknown field (mock_response)", {"mock_response": "x"}, None), ("num_retries", {"num_retries": 9}, None),
 ("timeout", {"timeout": 1}, None), ("metadata.tags", {"metadata": {"tags": ["x"]}}, None),
 ("header x-litellm-timeout", {}, {"x-litellm-timeout": "1"}), ("header openai-organization", {}, {"openai-organization": "org-x"}),
 ("header anthropic-beta (bad)", {}, {"anthropic-beta": "context-1m-2025-08-07"}), ("header anthropic-beta (ok)", {}, {"anthropic-beta": "fine-grained-tool-streaming-2025-05-14"}),
 ("provider fallbacks on", {"provider": {"allow_fallbacks": True}}, None), ("provider pinned (Pi)", {"provider": {"allow_fallbacks": False, "require_parameters": True, "only": ["openai"]}}, None)]
for t in ["msg", "resp", "cc"]:
    print(f"== {t} ({ROUTE[t]})")
    for name, extra, hdr in cases:
        if t != "cc" and name.startswith("provider"): continue
        body = json.loads(json.dumps({**base[t], **extra}).replace("{M}", MODELS[t]))
        s, e = post(t, body, hdr)
        print(f"  {name:32s} {s} {e[:100] if s!=200 else ''}")
