from drive import adm
for org, base in (("aaa", "http://ms-mock:8080/v1"), ("bbb", "http://ms-mock:8080/orgb-secret/v1")):
    adm("/model/new", {"model_name": f"org_{org}--chat", "litellm_params": {"model": "openai/gpt-mock", "api_base": base, "api_key": f"sk-upstream-{org}"}, "model_info": {"id": f"mdl-{org}-chat"}})
    adm("/team/new", {"team_id": f"team-{org}", "models": [f"org_{org}--chat"], "metadata": {"orgId": f"org_{org}"}})
    k = adm("/key/generate", {"models": [f"org_{org}--chat"], "team_id": f"team-{org}", "key_alias": f"key-{org}", "metadata": {"orgId": f"org_{org}"}})
    open(f"k{org[0]}.txt", "w").write(k["key"])
print("ok")
