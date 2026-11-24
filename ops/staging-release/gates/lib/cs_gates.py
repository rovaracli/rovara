#!/usr/bin/env python3
"""Gate 25 for the staging release pipeline: the scan of the change sets Preview made (port of the Mac 25-access-last-gates.py, upgrade mode).
OFFLINE: it reads the files in PREVIEW_DIR and nothing else; it never calls AWS and never reads a secret.

Usage: cs_gates.py <preview dir> <environment> <change set name> <results dir> <part> [<part> ...]
  The stacks are agentx-<environment>-access plus agentx-<environment>-<part> for each part. Per stack S the preview dir holds
  S.changeset.json, S.template.json, S.live-template.json, S.params.json, S.live-params.json.
  Exit 0 = every gate passed, 1 = a gate failed (or an input is missing or unreadable: fail closed), 2 = bad usage.

Gates (each failure prints a line with [FAIL] and the gate id):
  G0  one change set per stack, named exactly the pipeline's name, CREATE_COMPLETE/AVAILABLE (or CloudFormation's "no changes" answer)
  G1  no Remove and no Replacement on the protected list (gates/lib/protected.json)
  G2  DNS firewall: zero Remove and zero Replacement True|Conditional on AWS::Route53Resolver::* and AgentDnsFirewallQueryLogs1FB48960
  G3  Artifacts lifecycle: every live rule present, same selector, Expiration no shorter than live
  G4  broker: variant recorded; no broker ManagedPolicy is ADDED
  G5  every row is a Modify or the Remove of AWS::CDK::Metadata (any Add or other Remove fails: there is no reviewed-rows file in the pipeline)
  G6U access: no Remove and no Replacement except CDKMetadata (Adds and IAM property changes are WARN)
  G7  Core* parameters equal live where present; CoreEngine and CoreAllowedCompanies are not passed
  G8  DeveloperSignInTokenKey: no replace, no remove, no key-material property change
  G9  a value for CallbackSigningKey or any NoEcho parameter in the params files (FAIL: the files are uploaded)
  G10 batch 12/13 locations read from the TEMPLATES (names only, never values)
Dropped from the Mac script: the switch-over G6 and G7 pieces, --known-rows, --allow-patched (the pipeline has no local patches), --mark and the marker files (gates.sh writes the JSON marker).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "protected.json")) as _f:
    PROTECTED = {k: set(v) for k, v in json.load(_f).items()}
KEY_MATERIAL_PROPS = {"KeySpec", "KeyUsage", "MultiRegion", "Origin", "CustomerMasterKeySpec"}

results = []  # (gate, level, text); level PASS FAIL WARN INFO


def say(gate, level, text):
    results.append((gate, level, text))
    print(f"  [{level:4s}] {gate} {text}")


def load(p):
    with open(p) as f:
        return json.load(f)


def rows_of(cs):
    for c in cs.get("Changes", []) or []:
        yield c.get("ResourceChange", {})


def is_replace(rc):
    return rc.get("Replacement") in ("True", "Conditional")


def lifecycle_rules(template, logical):
    res = (template.get("Resources") or {}).get(logical) or {}
    return ((res.get("Properties") or {}).get("LifecycleConfiguration") or {}).get("Rules") or []


def _name_text(res):
    return json.dumps((res.get("Properties") or {}).get("Name", ""), sort_keys=True)


def lambda_env_keys(template):
    out = {}
    for lid, r in (template.get("Resources") or {}).items():
        if r.get("Type") == "AWS::Lambda::Function":
            env = (((r.get("Properties") or {}).get("Environment") or {}).get("Variables")) or {}
            out[lid] = sorted(env.keys()) if isinstance(env, dict) else []
    return out


def gate_g10(tpl):
    cp = tpl["control-plane"]
    res = cp.get("Resources") or {}
    ssm = [l for l, r in res.items() if r.get("Type") == "AWS::SSM::Parameter" and "broker-names" in _name_text(r)]
    sec = [l for l, r in res.items() if r.get("Type") == "AWS::SecretsManager::Secret" and "callback-key" in _name_text(r)]
    envs = {p: lambda_env_keys(tpl[p]) for p in ("control-plane", "slack") if p in tpl}
    all_envs = {f"{p}:{l}": k for p, d in envs.items() for l, k in d.items()}
    params_all = {p: set((tpl[p].get("Parameters") or {}).keys()) for p in envs}
    company = {k: [p for p in params_all if k in params_all[p]] for k in ("CompanySignIn", "CompanySelfServe", "SlackCompanyWorkspaces")}
    bad = []
    if not ssm and not sec:
        say("G10", "INFO", "template is pre-batch-12 (no broker-names parameter and no callback-key secret): the old locations apply")
    else:
        if not ssm:
            bad.append("callback-key secret present but no broker-names SSM parameter (#863 half moved)")
        if not sec:
            bad.append("broker-names SSM parameter present but no callback-key secret (#872 half moved)")
        for l in ssm:
            t = (res[l].get("Properties") or {}).get("Type")
            if t != "String":
                bad.append(f"{l}: SSM parameter Type is {t!r} (must be String)")
        for l in sec:
            dp = res[l].get("DeletionPolicy") or ""
            if not str(dp).startswith("Retain"):
                bad.append(f"{l}: callback-key secret DeletionPolicy is {dp!r} (must be Retain or RetainExceptOnCreate: it is the signing key)")
        broker = envs.get("control-plane", {}).get("BrokerE1355FD6", [])
        for need in ("AGENTX_NAMES_PARAMETER", "AGENTX_NAMES_REVISION", "CALLBACK_SIGNING_KEY_SECRET_ID"):
            if need not in broker:
                bad.append(f"broker env has no {need}")
        if "AGENTX_NAMES" in broker:
            bad.append("broker env still has AGENTX_NAMES (#863 moved it to the SSM parameter)")
        holders = sorted(k for k, v in all_envs.items() if "CALLBACK_SIGNING_KEY" in v)
        if holders:
            bad.append("Lambda env still has CALLBACK_SIGNING_KEY (#872): " + ", ".join(holders))
        users = sorted(k for k, v in all_envs.items() if "CALLBACK_SIGNING_KEY_SECRET_ID" in v)
        if not users:
            bad.append("no Lambda has CALLBACK_SIGNING_KEY_SECRET_ID")
        if "CallbackSigningKey" in params_all.get("control-plane", set()):
            say("G10", "WARN", "template still has the CallbackSigningKey stack parameter (the pipeline keeps the previous value)")
        if not bad:
            say("G10", "PASS", f"#863/#872: {ssm[0]} (String), {sec[0]} (retained); broker has AGENTX_NAMES_PARAMETER/REVISION and no AGENTX_NAMES; {len(users)} function(s) use CALLBACK_SIGNING_KEY_SECRET_ID, none CALLBACK_SIGNING_KEY")
    if any(company.values()):
        missing = [k for k, v in company.items() if not v]

        def _company_ok(val):
            return isinstance(val, dict) and list(val) == ["Fn::If"] and isinstance(val["Fn::If"], list) and len(val["Fn::If"]) == 3 \
                and str(val["Fn::If"][0]).startswith("CompanySignInSwitch") and val["Fn::If"][1:] == ["enabled", "disabled"]
        stale = []
        for p in envs:
            for lid, r in (tpl[p].get("Resources") or {}).items():
                if r.get("Type") != "AWS::Lambda::Function":
                    continue
                env = (((r.get("Properties") or {}).get("Environment") or {}).get("Variables")) or {}
                for key, val in (env.items() if isinstance(env, dict) else []):
                    if (key.startswith("COMPANY_SIGNIN") or key.startswith("COMPANY_SELF_SERVE")) and not _company_ok(val):
                        stale.append(f"{p}:{lid}:{key}")
        if missing:
            say("G10", "WARN", "company stack parameter(s) not in the control-plane or slack template: " + ", ".join(missing))
        if stale:
            bad.append("Lambda env COMPANY_SIGNIN*/COMPANY_SELF_SERVE value not taken from the CompanySignIn switch condition (#891): " + ", ".join(stale))
        say("G10", "INFO", "#891 company parameters in templates: " + "; ".join(f"{k} in {','.join(v) or 'none'}" for k, v in company.items()))
    else:
        say("G10", "INFO", "#891 not in this template: old COMPANY_SIGNIN env locations apply")
    if bad:
        say("G10", "FAIL", f"{len(bad)} batch 12/13 problem(s):")
        for x in bad:
            print(f"           - {x}")


def cp_param_values(cs, live):
    """Change-set parameter values: ResolvedValue, else ParameterValue, else (UsePreviousValue) the live value."""
    out = {}
    for p in cs.get("Parameters", []) or []:
        k = p.get("ParameterKey")
        if p.get("UsePreviousValue") is True and p.get("ResolvedValue") is None and p.get("ParameterValue") is None:
            out[k] = live.get(k)
        else:
            out[k] = p.get("ResolvedValue") if p.get("ResolvedValue") is not None else p.get("ParameterValue")
    return out


def main(argv):
    if len(argv) < 6:
        print(__doc__)
        return 2
    pdir, env, cs_name, rdir = argv[1:5]
    parts = ["access"] + [p for p in argv[5:] if p != "access"]
    os.makedirs(rdir, exist_ok=True)
    print(f"MODE: UPGRADE, preview dir {pdir}, change set {cs_name}; reviewed rows: none supplied (the pipeline has no reviewed-rows file)")
    cs, tpl, live, params, liveparams = {}, {}, {}, {}, {}
    for p in parts:
        base = f"{pdir}/agentx-{env}-{p}"
        for store, suffix in ((cs, "changeset"), (tpl, "template"), (live, "live-template"), (params, "params"), (liveparams, "live-params")):
            try:
                store[p] = load(f"{base}.{suffix}.json")
            except FileNotFoundError as e:
                say("G0", "FAIL", f"{p}: missing file {e.filename}")
            except ValueError as e:
                say("G0", "FAIL", f"{p}: {base}.{suffix}.json is not valid JSON ({e})")
    if any(r[1] == "FAIL" for r in results):
        return 1
    for p in parts:
        if not isinstance(cs[p], dict) or not isinstance(cs[p].get("Changes", []), list):
            say("G0", "FAIL", f"{p}: the change set file has no Changes list")
    for need in ("control-plane",):
        if need not in cs:
            say("G0", "FAIL", f"the parts list has no {need}")
    if any(r[1] == "FAIL" for r in results):
        return 1

    # G0
    for p in parts:
        d = cs[p]
        name = d.get("ChangeSetName", "")
        no_changes = d.get("Status") == "FAILED" and "contain changes" in (d.get("StatusReason") or "") and not (d.get("Changes") or [])
        ok = name == cs_name and ((d.get("Status") == "CREATE_COMPLETE" and d.get("ExecutionStatus") == "AVAILABLE") or no_changes)
        say("G0", "PASS" if ok else "FAIL", f"{p}: {name} {d.get('Status')}/{d.get('ExecutionStatus')} {d.get('StatusReason') or ''}".rstrip())

    # G1
    bad = []
    for p in parts:
        for rc in rows_of(cs[p]):
            if rc.get("LogicalResourceId") in PROTECTED.get(p, set()) and (rc.get("Action") == "Remove" or is_replace(rc)):
                bad.append(f"{p}/{rc['LogicalResourceId']} ({rc.get('Action')}, Replacement={rc.get('Replacement')})")
    say("G1", "FAIL" if bad else "PASS", ("protected resource removed or replaced: " + ", ".join(bad)) if bad else "no protected resource is removed or replaced")

    # G2
    bad = []
    for p in parts:
        for rc in rows_of(cs[p]):
            t, lid = rc.get("ResourceType", ""), rc.get("LogicalResourceId", "")
            if (t.startswith("AWS::Route53Resolver::") or lid == "AgentDnsFirewallQueryLogs1FB48960") and (rc.get("Action") == "Remove" or is_replace(rc)):
                bad.append(f"{p}/{lid} {t} ({rc.get('Action')}, Replacement={rc.get('Replacement')})")
    if bad:
        say("G2", "FAIL", f"{len(bad)} DNS-firewall row(s) would be removed or replaced (workers lose DNS filtering):")
        for b in bad:
            print(f"           - {b}")
    else:
        say("G2", "PASS", "no Remove or Replacement on AWS::Route53Resolver::* or AgentDnsFirewallQueryLogs1FB48960")

    # G3
    live_rules = lifecycle_rules(live["control-plane"], "Artifacts82DD59A1")
    new_rules = {r.get("Id"): r for r in lifecycle_rules(tpl["control-plane"], "Artifacts82DD59A1")}
    problems = []
    if not live_rules:
        say("G3", "WARN", "the live template has no Artifacts82DD59A1 lifecycle rules to compare")
    for r in live_rules:
        rid = r.get("Id")
        n = new_rules.get(rid)
        if n is None:
            problems.append(f"rule {rid} (live: {r.get('ExpirationInDays')} d, prefix {r.get('Prefix')}) is dropped: its objects stop expiring")
            continue
        sel_live = (r.get("Prefix"), json.dumps(r.get("TagFilters"), sort_keys=True))
        sel_new = (n.get("Prefix"), json.dumps(n.get("TagFilters"), sort_keys=True))
        if sel_live != sel_new:
            problems.append(f"rule {rid}: selector changed (prefix/tags) from {sel_live} to {sel_new}")
        if n.get("Status") != r.get("Status"):
            problems.append(f"rule {rid}: status {r.get('Status')} -> {n.get('Status')}")
        le, ne = r.get("ExpirationInDays"), n.get("ExpirationInDays")
        if le is not None and (ne is None or ne < le):
            problems.append(f"rule {rid}: Expiration shortened or removed ({le} d -> {ne}): older objects would be deleted within about a day")
    if problems:
        say("G3", "FAIL", f"{len(problems)} Artifacts lifecycle problem(s):")
        for x in problems:
            print(f"           - {x}")
    elif live_rules:
        say("G3", "PASS", "every live rule is kept with the same selector and an Expiration no shorter")

    # G4
    variant = "no broker change"
    for rc in rows_of(cs["control-plane"]):
        if rc.get("LogicalResourceId") == "BrokerE1355FD6":
            variant = "generated names (the Lambda and its role are REPLACED)" if is_replace(rc) else "fixed names (Lambda modified in place)"
    added = [rc["LogicalResourceId"] for rc in rows_of(cs["control-plane"]) if rc.get("Action") == "Add" and rc.get("ResourceType") == "AWS::IAM::ManagedPolicy" and rc.get("LogicalResourceId", "").startswith("BrokerServiceRole")]
    with open(os.path.join(rdir, "broker-variant.txt"), "w") as f:
        f.write(variant + "\n")
    say("G4", "INFO", f"broker variant: {variant}")
    say("G4", "FAIL" if added else "PASS", f"broker ManagedPolicy ADDED: {', '.join(added)}" if added else "no broker AWS::IAM::ManagedPolicy is added")

    # G5: the preview is its own reviewed set only if every row is a Modify or the CDKMetadata Remove.
    disallowed, repl_rows = [], []
    for p in parts:
        for rc in rows_of(cs[p]):
            act, lid, t = rc.get("Action"), rc.get("LogicalResourceId"), rc.get("ResourceType")
            if act == "Modify":
                if is_replace(rc):
                    repl_rows.append(f"{p}: Replacement {t} {lid}")
            elif act == "Remove" and t == "AWS::CDK::Metadata":
                pass
            else:
                disallowed.append(f"{p}: {act} {t} {lid}")
    if disallowed:
        say("G5", "FAIL", f"{len(disallowed)} row(s) are not a Modify or the CDKMetadata Remove (an Add or another Remove needs a person: the run is manual):")
        for x in disallowed:
            print(f"           - {x}")
    else:
        say("G5", "PASS", f"every row is a Modify or the CDKMetadata Remove; Replacement rows ({len(repl_rows)}) to read:")
        for x in repl_rows:
            print(f"           - {x}")

    # G6U
    bad, adds = [], []
    for rc in rows_of(cs["access"]):
        lid, t = rc.get("LogicalResourceId"), rc.get("ResourceType")
        if lid == "CDKMetadata" and t == "AWS::CDK::Metadata":
            continue
        if rc.get("Action") == "Remove" or is_replace(rc):
            bad.append(f"{rc.get('Action')} {t} {lid} (Replacement={rc.get('Replacement')})")
        elif rc.get("Action") == "Add":
            adds.append(f"Add {t} {lid}")
    if bad:
        say("G6U", "FAIL", "access change set removes or replaces something other than CDKMetadata:")
        for x in bad:
            print(f"           - {x}")
    else:
        say("G6U", "PASS", "access: no Remove and no Replacement except CDKMetadata")
    if adds:
        say("G6U", "WARN", "access change set ADDS resources (read them): " + ", ".join(adds))
    iam_mod = [f"{rc.get('ResourceType')} {rc.get('LogicalResourceId')}" for rc in rows_of(cs["access"])
               if rc.get("Action") == "Modify" and rc.get("ResourceType", "").startswith("AWS::IAM::") and set(rc.get("Scope") or []) - {"Metadata"}]
    if iam_mod:
        say("G6U", "WARN", "access change set changes IAM properties (the pipeline never deploys it; read them): " + ", ".join(iam_mod))

    # G7: Core* parameters equal live where present; the two removed by #1275 are not passed.
    live_cp = {e["ParameterKey"]: e.get("ParameterValue") for e in liveparams["control-plane"] if isinstance(e, dict) and "ParameterKey" in e}
    cp_params = cp_param_values(cs["control-plane"], live_cp)
    core_keys = ["CoreAgentModel", "CoreLessons", "CoreSystemRuns", "CoreCompanyDayCapUsd", "CoreTaskCapUsd", "CorePolicyHook"]
    diffs = []
    for k in core_keys:
        if k not in cp_params and k not in live_cp:
            continue
        if k not in cp_params or k not in live_cp:
            diffs.append(f"{k}: missing (change set {'has' if k in cp_params else 'lacks'} it, live {'has' if k in live_cp else 'lacks'} it)")
        elif cp_params[k] != live_cp[k]:
            diffs.append(f"{k}: change set {cp_params[k]!r} != live {live_cp[k]!r}")
    for k in ("CoreEngine", "CoreAllowedCompanies"):
        if k in cp_params:
            diffs.append(f"{k}: removed by #1275 but the change set still passes it ({cp_params[k]!r})")
    if diffs:
        say("G7", "FAIL", "Core* params differ from live: " + "; ".join(diffs))
    else:
        say("G7", "PASS", "the Core* params present equal live; CoreEngine and CoreAllowedCompanies are not passed")

    # G8
    bad = []
    for rc in rows_of(cs["control-plane"]):
        lid = rc.get("LogicalResourceId", "")
        if lid.startswith("DeveloperSignInTokenKey") and rc.get("ResourceType") == "AWS::KMS::Key":
            if rc.get("Action") == "Remove" or is_replace(rc):
                bad.append(f"{lid}: {rc.get('Action')} Replacement={rc.get('Replacement')}")
            for d in rc.get("Details", []) or []:
                if (d.get("Target") or {}).get("Name") in KEY_MATERIAL_PROPS:
                    bad.append(f"{lid}: key-material property {d['Target']['Name']} changes")
    say("G8", "FAIL" if bad else "PASS", ("; ".join(bad)) if bad else "DeveloperSignInTokenKey is not replaced or removed and no key-material property changes")

    # G9
    # In the pipeline the params files are UPLOADED (preview/<exec>/), so a value for CallbackSigningKey or for any NoEcho parameter is a FAIL, not a warning.
    holders = []
    for p in parts:
        noecho = {k for k, v in ((tpl.get(p) or {}).get("Parameters") or {}).items() if isinstance(v, dict) and str(v.get("NoEcho")).lower() == "true"} | {"CallbackSigningKey"}
        for e in params[p]:
            if isinstance(e, dict) and e.get("ParameterKey") in noecho and e.get("ParameterValue") not in (None, "", "****"):
                holders.append(f"agentx-{env}-{p}.params.json ({e.get('ParameterKey')})")
    if holders:
        say("G9", "FAIL", "the params file(s) hold an unmasked NoEcho value; they are uploaded, so it must never be there: " + ", ".join(holders))
    else:
        say("G9", "PASS", "no NoEcho parameter value in the params files")

    # G10
    gate_g10(tpl)

    fails = [r for r in results if r[1] == "FAIL"]
    print(f"\nSUMMARY: {sum(1 for r in results if r[1] == 'PASS')} pass, {len(fails)} FAIL, {sum(1 for r in results if r[1] == 'WARN')} warn")
    if fails:
        print("25- FAIL: no deploy while any gate fails.")
        return 1
    print("25- PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:  # fail closed: any unreadable or unexpected input is a failed gate
        print(f"  [FAIL] G0 the gate could not run ({type(exc).__name__}: {exc})")
        sys.exit(1)
