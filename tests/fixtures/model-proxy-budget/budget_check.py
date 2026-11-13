# Budget hold checks against real LiteLLM replicas sharing one Postgres, with the Rovara guard loaded as Cloud loads it.
# Used by tests/integration/model-proxy-budget-docker.test.ts (models: tests/fixtures/model-proxy-budget/models.yaml, upstream: upstream.py).
# Usage: python3 -I budget_check.py <proxy0 url> <proxy1 url> <postgres container>, SPIKE_MASTER_KEY set. Prints JSON lines; exits 1 on a failed check.
import concurrent.futures, json, os, socket, subprocess, sys, time, urllib.request

P0, P1, PG = sys.argv[1], sys.argv[2], sys.argv[3]
MASTER = os.environ["SPIKE_MASTER_KEY"]
FAILED = []


def check(name, ok, **detail):
    print(json.dumps({"check": name, "ok": bool(ok), **detail}), flush=True)
    if not ok:
        FAILED.append(name)


def post(base, path, body, key, timeout=60):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}", "x-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read().decode()


def sql(query):
    out = subprocess.run(["docker", "exec", PG, "psql", "-U", "litellm", "-d", "litellm", "-At", "-F", "|", "-c", query], capture_output=True, text=True, check=True)
    return [line.split("|") for line in out.stdout.strip().splitlines() if line]


def mint(budget):
    s, _, b = post(P0, "/key/generate", {"max_budget": budget, "models": ["anth", "anth-slow", "oai", "oai-slow", "oai-fail", "oai-flaky"]}, MASTER)
    assert s == 200, b
    info = json.loads(b)
    return info["key"], info["token"]


def body(route, model, stream, max_tokens=256):
    if route == "messages":
        return "/v1/messages", {"model": model, "max_tokens": max_tokens, "stream": stream, "messages": [{"role": "user", "content": "hi"}]}
    if route == "chat":
        b = {"model": model, "max_tokens": max_tokens, "stream": stream, "messages": [{"role": "user", "content": "hi"}]}
        if stream: b["stream_options"] = {"include_usage": True}
        return "/v1/chat/completions", b
    return "/v1/responses", {"model": model, "max_output_tokens": max_tokens, "stream": stream, "input": "hi"}


def cut(base, route, model, key, after_bytes=300):
    path, b = body(route, model, True)
    host, port = base.split("//")[1].split(":")
    data = json.dumps(b).encode()
    s = socket.create_connection((host, int(port)))
    s.sendall((f"POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nAuthorization: Bearer {key}\r\nx-api-key: {key}\r\nContent-Length: {len(data)}\r\n\r\n").encode() + data)
    got = b""
    while len(got) < after_bytes:
        chunk = s.recv(4096)
        if not chunk: break
        got += chunk
    s.close()
    return got.split(b" ", 2)[1].decode() if got else "?"


def ledger(token):
    rows = sql(f"SELECT charged_micros, held_micros FROM rovara_budget.keys WHERE key_hash = '{token}'")
    holds = sql(f"SELECT count(*) FROM rovara_budget.holds WHERE key_hash = '{token}'")
    return (int(rows[0][0]), int(rows[0][1]), int(holds[0][0])) if rows else (None, None, None)


def settled(token, wait=15):
    end = time.time() + wait
    while time.time() < end:
        c, h, n = ledger(token)
        if h == 0 and n == 0: return c, h, n
        time.sleep(0.5)
    return ledger(token)


# 1. every route, streamed and not, settles to its real cost (no hold left), on either replica
key, token = mint(100.0)
statuses = []
for i, (route, model) in enumerate((("messages", "anth"), ("chat", "oai"), ("responses", "oai"), ("messages", "oai"))):
    for stream in (False, True):
        s, _, _ = post(P0 if i % 2 == 0 else P1, *body(route, model, stream), key)
        statuses.append(s)
charged, held, holds = settled(token)
check("routes_settle_to_cost", statuses == [200] * 8 and held == 0 and holds == 0 and 0 < charged < 8 * 20_000, statuses=statuses, charged=charged, held=held, holds=holds)

def litellm_spend_micros(key, wait=60):
    """LiteLLM's own spend for the key once its batch writer has flushed everything (it writes about every 10 s): the first value that stays the same
    for 25 s (each replica flushes its own)."""
    def read():
        s, _, b = post_get(f"/key/info?key={key}")
        return int(round(float((json.loads(b).get("info") or {}).get("spend") or 0) * 1e6)) if s == 200 else -1
    end, last, since = time.time() + wait + 15, read(), time.time()
    while time.time() < end:
        time.sleep(1)
        now = read()
        if now != last: last, since = now, time.time()
        elif now > 0 and time.time() - since >= 25: return now
    return last


def post_get(path):
    req = urllib.request.Request(P0 + path, headers={"Authorization": f"Bearer {MASTER}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, None, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, None, e.read().decode()


litellm = litellm_spend_micros(key)
check("charged_matches_litellm_spend", abs(litellm - charged) <= 8, charged=charged, litellm=litellm)

# 1b. an upstream 500 then 200 (a provider hiccup): the router does not retry under the held call id, so the first call fails and is released, and the
# second is charged its cost, which LiteLLM's own spend agrees with (a router retry would run with no hold and never reach the ledger)
key, token = mint(100.0)
first, _, _ = post(P0, *body("chat", "oai-flaky", False), key)
second, _, _ = post(P0, *body("chat", "oai-flaky", False), key)
charged, held, holds = settled(token)
spent = litellm_spend_micros(key)
check("upstream_error_not_retried_under_hold", first == 500 and second == 200 and held == 0 and holds == 0 and charged > 0 and abs(spent - charged) <= 8,
      first=first, second=second, charged=charged, litellm=spent)

# 2. a stream the client cuts is charged its whole hold, on all three routes (LiteLLM itself logs only a partial cost, or none on Responses)
key, token = mint(100.0)
cuts = [cut(P0, "messages", "anth-slow", key), cut(P1, "chat", "oai-slow", key), cut(P0, "responses", "oai-slow", key)]
charged, held, holds = settled(token)
check("cut_streams_charged_in_full", cuts == ["200"] * 3 and held == 0 and holds == 0 and charged > 3 * 4_000, cuts=cuts, charged=charged)

# 2b. a cut stream's charge is an estimate: it is stamped in the key's metadata, where the broker reads it through /key/info (DECISIONS 172)
def estimated_stamp(key, want, wait=40):
    end, got = time.time() + wait, None
    while time.time() < end:
        s, _, b = post_get(f"/key/info?key={key}")
        got = ((json.loads(b).get("info") or {}).get("metadata") or {}).get("rovara_estimated_micros") if s == 200 else None
        if got == want: return got
        time.sleep(2)
    return got
stamped = estimated_stamp(key, charged)
check("estimated_charge_stamped_in_key_metadata", stamped == charged, stamped=stamped, charged=charged)

# 3. an error answer is not billed: the hold is released
key, token = mint(100.0)
s, _, _ = post(P1, *body("chat", "oai-fail", False), key)
charged, held, holds = settled(token)
check("error_answer_released", s == 400 and charged == 0 and held == 0 and holds == 0, status=s, charged=charged)

# 4. eight parallel calls over both replicas on a budget that fits two worst cases: two run, six get 429 budget_held, nothing overshoots
key, token = mint(0.04)
def one(i):
    return post(P0 if i % 2 == 0 else P1, *body("chat", "oai-slow", True, 1000), key)
with concurrent.futures.ThreadPoolExecutor(8) as pool:
    results = list(pool.map(one, range(8)))
codes = sorted(r[0] for r in results)
held_bodies = [json.loads(r[2]) for r in results if r[0] == 429]
charged, held, holds = settled(token)
check("parallel_no_overshoot", codes.count(200) == 2 and codes.count(429) == 6 and charged <= 40_000
      and all(b["error"]["type"] == "budget_held" for b in held_bodies) and all(r[1].get("retry-after") == "2" for r in results if r[0] == 429),
      codes=codes, charged=charged, sample=held_bodies[:1], retry_after=[r[1].get("retry-after") for r in results if r[0] == 429][:1])

# 5. 429 and 422 bodies on every route: a held budget, then a spent one
key, token = mint(0.02)
sql(f"INSERT INTO rovara_budget.keys (key_hash) VALUES ('{token}') ON CONFLICT DO NOTHING")
sql(f"INSERT INTO rovara_budget.holds (call_id, key_hash, reserved_micros, expires_at) VALUES ('blocker-{token[:8]}', '{token}', 18000, now() + interval '1 hour')")
sql(f"UPDATE rovara_budget.keys SET held_micros = held_micros + 18000 WHERE key_hash = '{token}'")
held_answers = {route: post(P0, *body(route, "oai" if route != "messages" else "anth", False), key) for route in ("messages", "chat", "responses")}
check("held_429_every_route", all(a[0] == 429 and json.loads(a[2])["error"]["type"] == "budget_held" and a[1].get("retry-after") == "2" for a in held_answers.values()),
      answers={r: (a[0], a[2][:160], a[1].get("retry-after")) for r, a in held_answers.items()})
sql(f"UPDATE rovara_budget.keys SET charged_micros = 19000 WHERE key_hash = '{token}'")
spent_answers = {route: post(P1, *body(route, "oai" if route != "messages" else "anth", False), key) for route in ("messages", "chat", "responses")}
check("spent_422_every_route", all(a[0] == 422 and json.loads(a[2])["error"]["type"] == "budget_exceeded" and json.loads(a[2])["error"]["message"].startswith("Budget has been exceeded! Key=")
                                   for a in spent_answers.values()), answers={r: (a[0], a[2][:200]) for r, a in spent_answers.items()})

# 5b. a room too small for the output limit asked but enough for a smaller one: 422 budget_max_tokens with the largest affordable limit (both envelopes),
# and the same call sent again with it is served
key, token = mint(0.2)
hinted = {route: post(P0 if route != "chat" else P1, *body(route, "oai" if route != "messages" else "anth", False, 16000), key) for route in ("messages", "chat")}
limits = {route: a[1].get("x-rovara-max-tokens") for route, a in hinted.items()}
served, _, _ = post(P1, *body("chat", "oai", False, int(limits["chat"] or 0)), key)
check("max_tokens_hint_every_route", all(a[0] == 422 and json.loads(a[2])["error"]["type"] == "budget_max_tokens" for a in hinted.values())
      and all(v is not None and int(v) >= 4096 for v in limits.values()) and served == 200, limits=limits, served=served,
      answers={r: (a[0], a[2][:160]) for r, a in hinted.items()})

# 6. an orphan (older than 1,000 s) becomes spent at the next call on its key
key, token = mint(1.0)
post(P0, *body("chat", "oai", False), key)
before, _, _ = settled(token)
sql(f"INSERT INTO rovara_budget.holds (call_id, key_hash, reserved_micros, expires_at) VALUES ('orphan-{token[:8]}', '{token}', 500000, now() - interval '1 second')")
sql(f"UPDATE rovara_budget.keys SET held_micros = held_micros + 500000 WHERE key_hash = '{token}'")
s, _, _ = post(P1, *body("chat", "oai", False), key)
after, held, holds = settled(token)
check("orphan_becomes_spent", s == 200 and held == 0 and holds == 0 and after >= before + 500000, before=before, after=after)

# 6b. an orphan of an overrun call (it held only the room that was left, its worst case was more) is charged its worst case, not that room (DECISIONS 165, 172; money review M1)
key, token = mint(1.0)
post(P0, *body("chat", "oai", False), key)
before, _, _ = settled(token)
sql(f"INSERT INTO rovara_budget.holds (call_id, key_hash, reserved_micros, worst_micros, expires_at) VALUES ('overrun-{token[:8]}', '{token}', 100000, 900000, now() - interval '1 second')")
sql(f"UPDATE rovara_budget.keys SET held_micros = held_micros + 100000 WHERE key_hash = '{token}'")
s, _, _ = post(P1, *body("chat", "oai", False), key)
after, held, holds = settled(token)
check("overrun_orphan_charged_worst_case", s == 200 and held == 0 and holds == 0 and after >= before + 900000, before=before, after=after, held=held, holds=holds)

print(json.dumps({"failed": FAILED}), flush=True)
sys.exit(1 if FAILED else 0)
