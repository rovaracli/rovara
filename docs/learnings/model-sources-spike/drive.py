import json, sys, time, urllib.request, urllib.error
MK = open("mk.txt").read().strip()
BASE = {"A": "http://localhost:14001", "B": "http://localhost:14002", "C": "http://localhost:14006"}
def adm(path, body=None, method=None, base="A"):
    r = urllib.request.Request(BASE[base] + path, data=(json.dumps(body).encode() if body is not None else None), method=method or ("POST" if body is not None else "GET"),
                               headers={"Authorization": "Bearer " + MK, "Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(r, timeout=30))
    except urllib.error.HTTPError as e: return {"_http": e.code, "_body": e.read().decode()[:400]}

TOOL = {"name": "read_file", "description": "read", "params": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}
def request_for(t, model, stream, tools):
    if t == "msg":
        b = {"model": model, "max_tokens": 64, "stream": stream, "messages": [{"role": "user", "content": "read README"}]}
        if tools: b["tools"] = [{"name": TOOL["name"], "description": TOOL["description"], "input_schema": TOOL["params"]}]
        return "/v1/messages", b, {"anthropic-version": "2023-06-01"}
    if t == "resp":
        b = {"model": model, "max_output_tokens": 64, "stream": stream, "input": "read README"}
        if tools: b["tools"] = [{"type": "function", "name": TOOL["name"], "description": TOOL["description"], "parameters": TOOL["params"]}]
        return "/v1/responses", b, {}
    b = {"model": model, "max_tokens": 64, "stream": stream, "messages": [{"role": "user", "content": "read README"}]}
    if stream: b["stream_options"] = {"include_usage": True}
    if tools: b["tools"] = [{"type": "function", "function": {"name": TOOL["name"], "description": TOOL["description"], "parameters": TOOL["params"]}}]
    return "/chat/completions", b, {}

def run(key, t, model, stream, tools, base="B", extra_body=None, extra_headers=None):
    path, body, hdr = request_for(t, model, stream, tools)
    if extra_body: body.update(extra_body)
    headers = {"Authorization": "Bearer " + key, "x-api-key": key, "Content-Type": "application/json", **hdr, **(extra_headers or {})}
    req = urllib.request.Request(BASE[base] + path, data=json.dumps(body).encode(), headers=headers)
    out = {"status": None, "events": 0, "text": "", "tool": None, "usage": None, "ctype": None, "err": None}
    try:
        resp = urllib.request.urlopen(req, timeout=25)
    except urllib.error.HTTPError as e:
        out["status"] = e.code; out["err"] = e.read().decode()[:300]; return out
    out["status"] = resp.status; out["ctype"] = resp.headers.get("content-type")
    if not stream:
        d = json.load(resp)
        if t == "msg":
            for c in d.get("content", []):
                if c["type"] == "text": out["text"] += c["text"]
                if c["type"] == "tool_use": out["tool"] = (c["name"], json.dumps(c["input"]))
            u = d.get("usage") or {}; out["usage"] = (u.get("input_tokens"), u.get("output_tokens"))
        elif t == "resp":
            for o in d.get("output", []):
                if o["type"] == "message": out["text"] += "".join(p.get("text", "") for p in o["content"])
                if o["type"] == "function_call": out["tool"] = (o["name"], o["arguments"])
            u = d.get("usage") or {}; out["usage"] = (u.get("input_tokens"), u.get("output_tokens"))
        else:
            m = d["choices"][0]["message"]; out["text"] = m.get("content") or ""
            if m.get("tool_calls"): out["tool"] = (m["tool_calls"][0]["function"]["name"], m["tool_calls"][0]["function"]["arguments"])
            u = d.get("usage") or {}; out["usage"] = (u.get("prompt_tokens"), u.get("completion_tokens"))
        return out
    # stream
    name = None; args = ""; ev = None; inp = outp = None
    for raw in resp:
        line = raw.decode().rstrip("\n")
        if line.startswith("event:"): ev = line[6:].strip(); continue
        if not line.startswith("data:"): continue
        data = line[5:].strip()
        if data == "[DONE]": out["events"] += 1; continue
        try: d = json.loads(data)
        except Exception: continue
        out["events"] += 1
        if t == "msg":
            ty = d.get("type")
            if ty == "message_start": inp = d["message"]["usage"].get("input_tokens")
            if ty == "content_block_start" and d["content_block"]["type"] == "tool_use": name = d["content_block"]["name"]
            if ty == "content_block_delta":
                dl = d["delta"]
                if dl["type"] == "text_delta": out["text"] += dl["text"]
                if dl["type"] == "input_json_delta": args += dl["partial_json"]
            if ty == "message_delta":
                u = d.get("usage") or {}; outp = u.get("output_tokens"); inp = u.get("input_tokens", inp) or inp
        elif t == "resp":
            ty = d.get("type")
            if ty == "response.output_text.delta": out["text"] += d["delta"]
            if ty == "response.output_item.added" and d["item"]["type"] == "function_call": name = d["item"]["name"]
            if ty == "response.function_call_arguments.delta": args += d["delta"]
            if ty == "response.completed":
                u = d["response"].get("usage") or {}; inp, outp = u.get("input_tokens"), u.get("output_tokens")
        else:
            for ch in d.get("choices", []):
                dl = ch.get("delta", {})
                if dl.get("content"): out["text"] += dl["content"]
                for tc in dl.get("tool_calls") or []:
                    if tc.get("function", {}).get("name"): name = tc["function"]["name"]
                    args += tc.get("function", {}).get("arguments") or ""
            if d.get("usage"): inp, outp = d["usage"].get("prompt_tokens"), d["usage"].get("completion_tokens")
    if name: out["tool"] = (name, args)
    out["usage"] = (inp, outp)
    return out

def new_key(models, **kw):
    r = adm("/key/generate", {"models": models, **kw})
    return r["key"], r

if __name__ == "__main__":
    which = sys.argv[1]
    if which == "matrix":
        results = {}
        for f in ["mr", "up", "lit"]:
            for t in ["msg", "resp", "cc"]:
                alias = f"m-{f}-{t}"
                key, _ = new_key([alias], key_alias=f"matrix{int(time.time())}-{alias}", metadata={"orgId": "org_matrix", "alias": alias})
                open(f"key-{alias}.txt", "w").write(key)
                row = {}
                for label, stream, tools in [("text", False, False), ("stream", True, False), ("tool", False, True), ("stream+tool", True, True)]:
                    r = run(key, t, alias, stream, tools)
                    row[label] = r
                    print(alias, label, "status", r["status"], "ev", r["events"], "ctype", (r["ctype"] or "")[:20], "text", repr(r["text"][:20]), "tool", r["tool"], "usage", r["usage"], "err", (r["err"] or "")[:120], flush=True)
                results[alias] = row
        json.dump(results, open("matrix-results.json", "w"), indent=1)
