import json, sys, time, urllib.request
RUNBASE = sys.argv[1] if len(sys.argv) > 1 else 'B'
from drive import adm, run, new_key
def mock(path): return json.load(urllib.request.urlopen("http://localhost:18080"+path))
cases = [("302", "canary", "http", 8080), ("307", "canary", "http", 8080), ("308", "canary", "http", 8080), ("302", "linklocal", "http", 8080), ("302", "canary-https", "https", 8443)]
models = []
for code, kind, scheme, port in cases:
    for t in ["cc", "resp", "msg"]:
        alias = f"r-{code}-{kind}-{t}"
        root = f"{scheme}://ms-mock:{port}/redir/{code}/{kind}"
        if t == "msg": lp = {"model": "anthropic/claude-mock", "api_base": root, "api_key": "sk-upstream-mock"}
        else: lp = {"model": "openai/gpt-mock", "api_base": root + "/v1", "api_key": "sk-upstream-mock"}
        if scheme == "https": lp["ssl_verify"] = False
        lp["timeout"] = 10; lp["num_retries"] = 0
        r = adm("/model/new", {"model_name": alias, "litellm_params": lp, "model_info": {"id": "id-" + alias}})
        models.append((alias, t, code, kind, scheme))
key, _ = new_key([m[0] for m in models], key_alias=f"q9-{int(time.time())}")
if len(sys.argv) > 2: key = open(sys.argv[2]).read().strip()
time.sleep(1)
for alias, t, code, kind, scheme in models:
    for stream in (False, True):
        urllib.request.urlopen("http://localhost:18080/_clear").read()
        t0 = time.time()
        r = run(key, t, alias, stream, False, base=RUNBASE)
        seen = [(e["port"], e["method"], e["path"][:40]) for e in mock("/_log")]
        canary = [s for s in seen if s[0] == 9100]
        print(f"{alias:28s} stream={stream!s:5s} status={r['status']} {time.time()-t0:4.1f}s canary_hits={len(canary)} upstream_hits={len([s for s in seen if s[0]!=9100])} err={(r['err'] or '')[:150]!r}", flush=True)
