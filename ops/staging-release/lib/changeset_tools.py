#!/usr/bin/env python3
"""Helpers for the gate pack's Preview (ported from the Mac's changeset_tools.py). LOCAL ONLY: reads files the shell scripts wrote; never calls AWS.

  params  <template.json> <live-params.json|-> <overrides.json> <part> <outputs.json|-> <out-params.json>
      Builds create-change-set --parameters: an override wins; else a parameter the live stack already has keeps its value (UsePreviousValue; this is how the
      NoEcho CallbackSigningKey is never read or printed); else a parameter whose name equals an output of an already-deployed stack of the same environment
      takes that output; else the template default; else it is MISSING (exit 2). An override that is a placeholder ("@...") is REFUSED: a pipeline change set is executed.
  slack-cp-outputs <new control-plane template.json> <outputs.json> <slack template.json> <overrides.json> <slack params.json>
      Models what the CLI sends the slack stack AFTER the control plane deploys (the four optional control-plane outputs), so the slack change set made before
      the control plane deploys matches what a real deploy would send.
  minify  <template.json> <out.json>          compact JSON; exit 3 if over CloudFormation's 1,048,576-byte S3 limit
  template-file <manifest.json> <construct id>   prints the template file name of a synthesized stack
"""
import json, os, sys


def load(p):
    if p == "-" or not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def cmd_params(tpl, live_p, ovr_p, part, outs_p, out_p):
    t = load(tpl)
    live_doc = load(live_p) or []
    live = {p["ParameterKey"]: p.get("ParameterValue") for p in live_doc}
    ovr = (load(ovr_p) or {}).get(part, {})
    outs = {o["OutputKey"]: o["OutputValue"] for o in (load(outs_p) or [])}
    params, missing, used = [], [], {}
    for k, spec in (t.get("Parameters") or {}).items():
        if k in ovr:
            v = ovr[k]
            if isinstance(v, str) and v.startswith("@"):
                # The Mac preview made throwaway values for NoEcho secrets. A pipeline change set is executed, so a placeholder value must never reach it.
                sys.exit(f"REFUSED: override {part}.{k} is a placeholder ({v}); a pipeline change set is executed")
            if spec.get("NoEcho"):
                # overrides.json comes out of Build (merged code): a secret parameter must never take a value from it, and the value would land in the uploaded params file
                sys.exit(f"REFUSED: override {part}.{k} names a NoEcho parameter; only previous values are used for those")
            used[k] = "override"
            params.append({"ParameterKey": k, "ParameterValue": str(v)})
        elif k in live:
            params.append({"ParameterKey": k, "UsePreviousValue": True}); used[k] = "previous value"
        elif k in outs:
            params.append({"ParameterKey": k, "ParameterValue": outs[k]}); used[k] = "from a deployed stack's output"
        elif "Default" in spec:
            used[k] = f"template default {json.dumps(spec['Default'])[:60]}"
        else:
            missing.append(k)
    with open(out_p, "w") as f:
        json.dump(params, f, indent=1)
    for k, how in sorted(used.items()):
        print(f"  param {k}: {how}")
    dropped = sorted(set(live) - set((t.get("Parameters") or {}).keys()) - {"BootstrapVersion"})
    if dropped:
        print(f"  live parameters the new template drops (values lost; the previous release's stacks): {', '.join(dropped)}")
    if missing:
        print(f"  MISSING (no live value, no output, no default): {', '.join(missing)}; add them to the overrides file under \"{part}\"")
        sys.exit(2)


SLACK_CP_OUTPUTS = ["ChannelRequestQueueUrl", "ChannelEventQueueUrl", "SlackAdapterCommandsUrl", "SlackAdapterSecretName"]


def _resolve_cp_output(value, live_outs):
    """A new control-plane output's value as known before the deploy: (value, how), or (None, why) when it is only known at deploy."""
    if isinstance(value, str):
        return value, "literal in the new control-plane template"
    if isinstance(value, dict) and list(value) == ["Fn::Join"]:
        sep, parts = value["Fn::Join"]
        out = []
        for part in parts:
            if isinstance(part, str):
                out.append(part)
            elif part == {"Fn::GetAtt": ["HttpApi", "ApiEndpoint"]} and live_outs.get("ApiEndpoint"):
                out.append(live_outs["ApiEndpoint"])
            else:
                return None, f"a Join over {json.dumps(part)[:80]}, known only after the deploy"
        return sep.join(out), "Join of literals and the live control-plane ApiEndpoint (HttpApi is kept, not replaced)"
    if isinstance(value, dict) and "Ref" in value:
        return None, f"Ref {value['Ref']} (a new resource; its name/URL is generated at deploy)"
    return None, f"{json.dumps(value)[:80]}, known only after the deploy"


def cmd_slack_cp_outputs(cp_tpl, outs_p, slack_tpl, ovr_p, params_p):
    cp = load(cp_tpl) or {}
    new_outputs = cp.get("Outputs") or {}
    live_outs = {o["OutputKey"]: o["OutputValue"] for o in (load(outs_p) or [])}
    declared = (load(slack_tpl) or {}).get("Parameters") or {}
    ovr = (load(ovr_p) or {}).get("slack", {})
    params = load(params_p) or []
    by_key = {p["ParameterKey"]: p for p in params}
    final = {}
    for k in SLACK_CP_OUTPUTS:
        if k not in declared:
            continue
        if k in ovr:
            final[k] = str(ovr[k]); print(f"  param {k}: override (the CLI would send the control plane's output instead)")
            continue
        if k not in new_outputs:
            print(f"  param {k}: the new control-plane template has no such output: the CLI sends nothing (previous value / template default)")
            prev = by_key.get(k)
            final[k] = live_outs.get(k, "") if prev is not None else str(declared[k].get("Default", ""))
            continue
        if live_outs.get(k):
            v, how = live_outs[k], "the deployed control plane already outputs it (resource kept)"
        else:
            v, how = _resolve_cp_output(new_outputs[k].get("Value"), live_outs)
            if v is None:
                # The Mac preview put a marked placeholder here. A pipeline change set is executed, so a value that is only known after the control plane deploys
                # cannot be part of it: this release needs the two-step hand deploy.
                sys.exit(f"REFUSED: slack parameter {k} depends on a control-plane output known only after the control plane deploys ({how}); this release needs a hand deploy")
        by_key[k] = {"ParameterKey": k, "ParameterValue": v}
        final[k] = v
        print(f"  param {k}: set at deploy: control-plane output {k} ({how}); preview value {v}")
    params = [p for p in params if p["ParameterKey"] not in by_key] + list(by_key.values())
    with open(params_p, "w") as f:
        json.dump(params, f, indent=1)
    if final.get("ChannelRequestQueueUrl") and final.get("ChannelEventQueueUrl"):
        print("  >>> NOTE: both channel queue URLs will be SET at deploy: the Slack service STARTS its channel-queue consumer and the Slack adapter"
              " client (slack-service/src/main.ts). The control plane's ChannelAdapters/SlackViaChannel stay as the overrides/live set them.")


def cmd_minify(tpl, out):
    data = json.dumps(load(tpl), separators=(",", ":")).encode()
    with open(out, "wb") as f:
        f.write(data)
    print(f"  template {len(data)} bytes minified")
    if len(data) > 1048576:
        print("  TOO BIG for CloudFormation (1,048,576 bytes from S3)"); sys.exit(3)


def cmd_template_file(manifest, cid):
    m = load(manifest)
    art = (m.get("artifacts") or {}).get(cid)
    if not art:
        sys.exit(f"no stack {cid} in {manifest}")
    print(art["properties"]["templateFile"])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    fns = {"params": cmd_params, "slack-cp-outputs": cmd_slack_cp_outputs, "minify": cmd_minify, "template-file": cmd_template_file}
    if sys.argv[1] not in fns:
        sys.exit(f"unknown command {sys.argv[1]}")
    fns[sys.argv[1]](*sys.argv[2:])
