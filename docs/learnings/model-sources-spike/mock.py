import json, ssl, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = []
IN_TOK, OUT_TOK = 1000, 200
CACHE_READ, CACHE_WRITE, REASON = 400, 200, 50
LOCK = threading.Lock()

def rec(port, h, body):
    ent = {"t": round(time.time(), 3), "port": port, "method": h.command, "path": h.path,
           "host": h.headers.get("Host"), "has_auth": bool(h.headers.get("Authorization") or h.headers.get("x-api-key")),
           "extra_headers": [k for k in h.headers.keys() if k.lower().startswith("x-spike")],
           "auth_tail": ((h.headers.get("Authorization") or h.headers.get("x-api-key") or "")[-10:]),
           "model": (body or {}).get("model") if isinstance(body, dict) else None,
           "body": body if isinstance(body, dict) else None, "header_names": sorted(k.lower() for k in h.headers.keys()), "beta": h.headers.get("anthropic-beta")}
    with LOCK:
        LOG.append(ent)
    print(json.dumps(ent), flush=True)

def sse(h, events):
    h.send_response(200); h.send_header("Content-Type", "text/event-stream"); h.send_header("Cache-Control", "no-cache"); h.send_header("Connection", "close"); h.end_headers(); h.close_connection = True
    for name, data in events:
        chunk = (f"event: {name}\n" if name else "") + "data: " + (data if isinstance(data, str) else json.dumps(data)) + "\n\n"
        h.wfile.write(chunk.encode()); h.wfile.flush()

def js(h, obj, code=200):
    b = json.dumps(obj).encode(); h.send_response(code); h.send_header("Content-Type", "application/json"); h.send_header("Content-Length", str(len(b))); h.end_headers(); h.wfile.write(b)

def wants_tool(body, kind):
    tools = body.get("tools")
    if not tools: return False
    s = json.dumps(body.get("messages") if kind != "resp" else body.get("input"))
    return not ('"role": "tool"' in s or '"tool_result"' in s or '"function_call_output"' in s)

def tool_name(body):
    t = body["tools"][0]
    return t.get("name") or t.get("function", {}).get("name") or "read_file"

def chat(h, body):
    mid = "chatcmpl-" + uuid.uuid4().hex[:12]; model = body.get("model", "m"); tool = wants_tool(body, "chat")
    usage = {"prompt_tokens": IN_TOK + CACHE_READ, "completion_tokens": OUT_TOK, "total_tokens": IN_TOK + CACHE_READ + OUT_TOK, "prompt_tokens_details": {"cached_tokens": CACHE_READ}, "completion_tokens_details": {"reasoning_tokens": REASON}, **({} if "/nocost/" in h.path else {"cost": 0.01234})}
    if not body.get("stream"):
        msg = {"role": "assistant", "content": None if tool else "Mock reply",
               **({"tool_calls": [{"id": "call_1", "type": "function", "function": {"name": tool_name(body), "arguments": "{\"path\":\"README.md\"}"}}]} if tool else {})}
        return js(h, {"id": mid, "object": "chat.completion", "created": int(time.time()), "model": model,
                      "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tool else "stop"}], "usage": usage})
    base = {"id": mid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
    ev = [(None, {**base, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})]
    if tool:
        ev.append((None, {**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": tool_name(body), "arguments": ""}}]}, "finish_reason": None}]}))
        for part in ['{"path"', ':"README.md"}']:
            ev.append((None, {**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": part}}]}, "finish_reason": None}]}))
    else:
        for part in ["Mock ", "reply"]:
            ev.append((None, {**base, "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}]}))
    ev.append((None, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}]}))
    ev.append((None, {**base, "choices": [], "usage": usage}))
    ev.append((None, "[DONE]"))
    sse(h, ev)

def responses(h, body):
    rid = "resp_" + uuid.uuid4().hex[:12]; model = body.get("model", "m"); tool = wants_tool(body, "resp")
    usage = {"input_tokens": IN_TOK + CACHE_READ, "output_tokens": OUT_TOK, "total_tokens": IN_TOK + CACHE_READ + OUT_TOK, "input_tokens_details": {"cached_tokens": CACHE_READ}, "output_tokens_details": {"reasoning_tokens": REASON}}
    if tool:
        item = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": tool_name(body), "arguments": "{\"path\":\"README.md\"}", "status": "completed"}
    else:
        item = {"type": "message", "id": "msg_1", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": "Mock reply", "annotations": []}]}
    full = {"id": rid, "object": "response", "created_at": int(time.time()), "status": "completed", "model": model, "output": [item], "usage": usage,
            "parallel_tool_calls": True, "tool_choice": "auto", "tools": body.get("tools") or []}
    if not body.get("stream"): return js(h, full)
    inprog = {**full, "status": "in_progress", "output": [], "usage": None}
    ev = [("response.created", {"type": "response.created", "sequence_number": 0, "response": inprog}),
          ("response.in_progress", {"type": "response.in_progress", "sequence_number": 1, "response": inprog})]
    if tool:
        ev += [("response.output_item.added", {"type": "response.output_item.added", "sequence_number": 2, "output_index": 0, "item": {**item, "arguments": "", "status": "in_progress"}}),
               ("response.function_call_arguments.delta", {"type": "response.function_call_arguments.delta", "sequence_number": 3, "item_id": "fc_1", "output_index": 0, "delta": "{\"path\":\"README.md\"}"}),
               ("response.function_call_arguments.done", {"type": "response.function_call_arguments.done", "sequence_number": 4, "item_id": "fc_1", "output_index": 0, "arguments": "{\"path\":\"README.md\"}"}),
               ("response.output_item.done", {"type": "response.output_item.done", "sequence_number": 5, "output_index": 0, "item": item})]
    else:
        ev += [("response.output_item.added", {"type": "response.output_item.added", "sequence_number": 2, "output_index": 0, "item": {"type": "message", "id": "msg_1", "status": "in_progress", "role": "assistant", "content": []}}),
               ("response.content_part.added", {"type": "response.content_part.added", "sequence_number": 3, "item_id": "msg_1", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})]
        for i, part in enumerate(["Mock ", "reply"]):
            ev.append(("response.output_text.delta", {"type": "response.output_text.delta", "sequence_number": 4 + i, "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": part}))
        ev += [("response.output_text.done", {"type": "response.output_text.done", "sequence_number": 6, "item_id": "msg_1", "output_index": 0, "content_index": 0, "text": "Mock reply"}),
               ("response.content_part.done", {"type": "response.content_part.done", "sequence_number": 7, "item_id": "msg_1", "output_index": 0, "content_index": 0, "part": item["content"][0]}),
               ("response.output_item.done", {"type": "response.output_item.done", "sequence_number": 8, "output_index": 0, "item": item})]
    ev.append(("response.completed", {"type": "response.completed", "sequence_number": 9, "response": full}))
    sse(h, ev)

def anthropic(h, body):
    mid = "msg_" + uuid.uuid4().hex[:12]; model = body.get("model", "m"); tool = wants_tool(body, "ant")
    content = [{"type": "tool_use", "id": "toolu_1", "name": tool_name(body), "input": {"path": "README.md"}}] if tool else [{"type": "text", "text": "Mock reply"}]
    stop = "tool_use" if tool else "end_turn"
    if not body.get("stream"):
        return js(h, {"id": mid, "type": "message", "role": "assistant", "model": model, "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": IN_TOK, "output_tokens": OUT_TOK, "cache_creation_input_tokens": CACHE_WRITE, "cache_read_input_tokens": CACHE_READ}})
    ev = [("message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": IN_TOK, "output_tokens": 1, "cache_creation_input_tokens": CACHE_WRITE, "cache_read_input_tokens": CACHE_READ}}})]
    if tool:
        ev += [("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": tool_name(body), "input": {}}})]
        for part in ['{"path"', ':"README.md"}']:
            ev.append(("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": part}}))
    else:
        ev += [("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})]
        for part in ["Mock ", "reply"]:
            ev.append(("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": part}}))
    ev += [("content_block_stop", {"type": "content_block_stop", "index": 0}),
           ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": OUT_TOK}}),
           ("message_stop", {"type": "message_stop"})]
    sse(h, ev)

def make_handler(port, canary=False):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            try: return json.loads(raw) if raw else None
            except Exception: return None
        def do_GET(self):
            if self.path == "/_log": return js(self, LOG)
            if self.path == "/_clear":
                with LOCK: LOG.clear()
                return js(self, {"ok": True})
            rec(port, self, None)
            if self.path.rstrip("/").endswith("/models"): return js(self, {"object": "list", "data": [{"id": "mock", "object": "model"}]})
            return js(self, {"ok": True, "canary": canary})
        def do_POST(self):
            body = self._body(); rec(port, self, body)
            p = self.path.split("?")[0]
            if canary: return js(self, {"canary": "hit"})
            if p.startswith("/redir/"):
                _, _, code, kind = p.split("/", 4)[:4]
                loc = {"canary": "http://ms-canary:9100/hit", "linklocal": "http://169.254.169.254/latest/meta-data/", "canary-https": "http://ms-canary:9100/hit"}[kind]
                self.send_response(int(code)); self.send_header("Location", loc); self.send_header("Content-Length", "0"); self.end_headers(); return
            if self.headers.get("X-Amz-Target", "").startswith("secretsmanager."):
                return js(self, {"ARN": "arn:aws:secretsmanager:us-east-1:000000000000:secret:fake", "Name": "fake", "SecretString": "sk-fake-sm-" + str((body or {}).get("SecretId","?")).replace("/","_"), "VersionId": "v1"})
            if p.endswith("/chat/completions"): return chat(self, body or {})
            if p.endswith("/responses"): return responses(self, body or {})
            if p.endswith("/messages"): return anthropic(self, body or {})
            return js(self, {"error": "unknown path " + p}, 404)
    return H

def serve(port, tls=False, canary=False):
    srv = ThreadingHTTPServer(("0.0.0.0", port), make_handler(port, canary))
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain("/spike/cert.pem", "/spike/key.pem")
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

serve(8080); serve(8443, tls=True); serve(9100, canary=True)
print("mock up", flush=True)
while True: time.sleep(3600)
