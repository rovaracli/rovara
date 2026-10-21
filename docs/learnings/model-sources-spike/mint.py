"""mintKey prototype: closed schema in, post-mint verification out. Shows what LiteLLM accepts, and that the checks catch it."""
import json, re, sys
from drive import adm, run
ALIAS = re.compile(r"^org_[a-z0-9]{20}--[a-z0-9][a-z0-9-]{0,40}$")   # server-derived: org_<orgId>--<slug>
def validate_mint(body, org_id, team_models):
    """Refuses everything the spike found LiteLLM would honour. Raises ValueError."""
    extra = set(body) - {"models", "team_id", "key_alias", "max_budget", "budget_duration", "duration", "metadata", "allowed_routes"}
    if extra: raise ValueError(f"unknown key field {sorted(extra)[0]}")          # no aliases, tags, permissions, model_max_budget, user_id, ...
    models = body.get("models")
    if not isinstance(models, list) or not models: raise ValueError("models must be a non-empty list")
    for m in models:
        if not ALIAS.fullmatch(m) or not m.startswith(f"org_{org_id}--") and not m.startswith("org_"): raise ValueError(f"model {m!r} is not an org alias")
        if org_id and not m.startswith(f"org_{org_id}--") : raise ValueError(f"model {m!r} belongs to another org")
    if not body.get("team_id"): raise ValueError("team_id required")
    if not team_models: raise ValueError("team models must be non-empty")
    for m in team_models:
        if not ALIAS.fullmatch(m) and m not in CATALOG: raise ValueError(f"team model {m!r} is a wildcard, group or unknown")
    return body
CATALOG = {"us.anthropic.claude-sonnet-4-6"}
def verify_minted(key_info, requested, team_info):
    i = key_info["info"]
    assert i["models"] == requested, f"models drifted: {i['models']}"
    assert not i.get("aliases"), "aliases set"
    assert i.get("team_id") and set(team_info["team_info"]["models"]) and "*" not in "".join(i["models"]) and "all-proxy-models" not in i["models"]
    for t in team_info["team_info"]["models"]: assert t != "all-proxy-models" and "*" not in t, "wildcard team model"
if __name__ == "__main__":
    org = "a" * 20
    # --- what LiteLLM itself accepts and honours (the reason validate_mint exists) ---
    adm("/model/new", {"model_name": "org_bbb--chat2", "litellm_params": {"model": "openai/gpt-mock", "api_base": "http://ms-mock:8080/v1", "api_key": "x"}, "model_info": {"id": "mdl-grp", "access_groups": ["grp-shared"]}})
    adm("/team/new", {"team_id": "team-empty", "models": []})
    adm("/team/new", {"team_id": "team-star", "models": ["*"]})
    cases = [
        ("key models ['*']", {"models": ["*"]}),
        ("key models ['openai/*']", {"models": ["openai/*"]}),
        ("key models ['all-proxy-models']", {"models": ["all-proxy-models"]}),
        ("key models [<access group>]", {"models": ["grp-shared"]}),
        ("key models [] (empty)", {"models": []}),
        ("key models [] in team-empty", {"models": [], "team_id": "team-empty"}),
        ("key models [<aaa alias>] + aliases->bbb", {"models": ["org_aaa--chat"], "aliases": {"friendly": "org_bbb--chat"}}),
        ("key models [<aaa alias>] + team-star", {"models": ["org_aaa--chat"], "team_id": "team-star"}),
    ]
    for name, body in cases:
        r = adm("/key/generate", {**body, "key_alias": "mint-" + re.sub(r"\W+", "-", name)[:30]})
        if "key" not in r: print(f"  {name:42s} LiteLLM refused: {str(r)[:90]}"); continue
        key = r["key"]
        reach = {}
        for target in ("org_aaa--chat", "org_bbb--chat", "static-mock"):
            res = run(key, "cc", target, False, False, base="A", extra_body=None)
            reach[target] = res["status"]
        print(f"  {name:42s} minted; reaches {reach}")
    print("-- validate_mint on the same bodies (org aaa-like id):")
    for name, body in cases + [("legit", {"models": [f"org_{org}--chat"], "team_id": "team-x"})]:
        try: validate_mint({**body}, org, [f"org_{org}--chat"] if name != "key models [] in team-empty" else []); print(f"  {name:42s} ACCEPTED")
        except ValueError as e: print(f"  {name:42s} refused: {e}")
