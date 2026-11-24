#!/usr/bin/env python3
"""Decide's input assembly (plan v3 stage 6; P-SEP, P-CI, P-ORDER, P-RB). Builds the one JSON document the policy evaluator reads, and the record Deploy re-checks.

  decide_input.py <input.json> <record.json>

Everything is gathered here, by the Decide role, from sources the merged repository's code cannot write:
  - CloudFormation itself: every change set (all pages, with property values), the template CloudFormation received, the live template and the live parameters;
  - the pinned gate pack on disk (policy files and the manifest of EVERY file, spelled as `sha256sum` prints it from inside ops/staging-release);
  - git DATA from the commit Build bundled (the bundle must hold exactly RELEASE_SHA, so the history is the real one: a commit id fixes its whole tree and ancestry); git runs only
    plumbing commands in a bare repository, never a checkout, so no hook, filter or attribute file of the repository can run;
  - SSM (pointers, pin, holds), ECR (image tags), the pipeline execution (trigger kind and variables), the run records in S3;
  - GitHub's public API without a token (CI evidence, matched by git tree id).
Build's files are used only where the package hash binds them (answers, overrides, images, the npm ci dry run): Decide re-hashes the release package and refuses one that
differs from the hash Preview recorded. A failure to gather anything stops with a reason (the caller turns that into MANUAL); nothing is guessed.
Environment: ENVIRONMENT PIPELINE_KIND EXEC_ID RELEASE_SHA RUNS_BUCKET PARAM_PREFIX PACK_DIR WORK; optional PIPELINE_NAME, MODE (push|rollback), GITHUB_API, CI_WAIT_MINUTES,
CI_POLL_SECONDS, PRIOR_AUTO_ROLLBACKS (rollback mode), REGION. AWS and git are used through their command line tools.
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

E = os.environ
REGION = "us-west-2"
HEX40 = re.compile(r"^[0-9a-f]{40}$")


class Stop(Exception):
    """A reason the input could not be assembled; the verdict is MANUAL with this text."""


def need(name):
    v = E.get(name, "")
    if not v:
        raise Stop(f"environment variable {name} is not set")
    return v


ENVIRONMENT = need("ENVIRONMENT")
KIND = E.get("PIPELINE_KIND", "code")
EXEC_ID = need("EXEC_ID")
SHA = need("RELEASE_SHA")
BUCKET = need("RUNS_BUCKET")
PREFIX = E.get("PARAM_PREFIX", f"/rovara-release/{ENVIRONMENT}")
PACK = need("PACK_DIR")
WORK = need("WORK")
MODE = E.get("MODE", "push")
CS_NAME = f"rovara-pipeline-{EXEC_ID[:8]}"
if not HEX40.match(SHA):
    raise Stop("RELEASE_SHA is not a 40-hex sha")
if MODE not in ("push", "rollback"):
    raise Stop("MODE must be push or rollback")


def run(cmd, check=True, input_bytes=None, env=None):
    r = subprocess.run(cmd, capture_output=True, input=input_bytes, env=env)
    if check and r.returncode != 0:
        raise Stop(f"{' '.join(cmd[:3])} failed: {r.stderr.decode(errors='replace').strip()[-300:]}")
    return r


def aws(*args, check=True):
    r = run(["aws", *args, "--region", REGION, "--output", "json"], check=check)
    if r.returncode != 0:
        return None
    out = r.stdout.decode().strip()
    return json.loads(out) if out else {}


def s3_get(key, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    r = run(["aws", "s3", "cp", "--only-show-errors", f"s3://{BUCKET}/{key}", dest, "--region", REGION], check=False)
    return r.returncode == 0


def s3_get_dir(prefix, dest):
    os.makedirs(dest, exist_ok=True)
    r = run(["aws", "s3", "cp", "--recursive", "--only-show-errors", f"s3://{BUCKET}/{prefix}", dest, "--region", REGION], check=False)
    return r.returncode == 0


def s3_list(prefix):
    doc = aws("s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", prefix, check=False) or {}
    return [c["Key"] for c in doc.get("Contents", [])]


def ssm(name):
    """The parameter's value; None only for a plain ParameterNotFound. Any other failure (throttling, AccessDenied, network) stops the assembly: unreadable is not absent."""
    r = run(["aws", "ssm", "get-parameter", "--name", name, "--region", REGION, "--output", "json"], check=False)
    if r.returncode != 0:
        if b"ParameterNotFound" in r.stderr:
            return None
        raise Stop(f"cannot read parameter {name}: {r.stderr.decode(errors='replace').strip()[-200:]}")
    return json.loads(r.stdout.decode() or "{}").get("Parameter", {}).get("Value")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def file_sha(path):
    with open(path, "rb") as f:
        return sha256_bytes(f.read())


def canon_sha(text):
    """sha256 of `jq -cS .` of a JSON text: the same canonical form the Preview and Deploy scripts hash (one tool, so the bytes agree)."""
    r = run(["jq", "-cS", "."], input_bytes=text.encode())
    return sha256_bytes(r.stdout)


def glob_re(glob):
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            if glob[i + 1:i + 2] == "*":
                if glob[i + 2:i + 3] == "/":
                    out += "(?:.*/)?"; i += 3
                else:
                    out += ".*"; i += 2
            else:
                out += "[^/]*"; i += 1
        elif c == "?":
            out += "[^/]"; i += 1
        else:
            out += re.escape(c); i += 1
    return re.compile("^" + out + "$", re.IGNORECASE)


# ---------------------------------------------------------------- the pack, the pin, the policy
policy_files = {}
for name in ("auto-approve-policy.json", "manual-paths.txt", "rollback-floor.txt"):
    with open(os.path.join(PACK, "policy", name), encoding="utf-8") as f:
        policy_files[name] = f.read()
policy = json.loads(policy_files["auto-approve-policy.json"])
pipeline_cfg = (policy.get("pipelines") or {}).get(KIND)
if pipeline_cfg is None:
    raise Stop(f"the policy has no pipeline {KIND}")


def pack_manifest():
    entries = []
    for root, dirs, files in os.walk(PACK):
        dirs.sort()
        for n in files:
            full = os.path.join(root, n)
            if os.path.islink(full) or not os.path.isfile(full):
                raise Stop(f"the gate pack holds a non-regular file: {full}")
            entries.append("./" + os.path.relpath(full, PACK).replace(os.sep, "/"))
        for d in dirs:
            if os.path.islink(os.path.join(root, d)):
                raise Stop(f"the gate pack holds a symlink: {os.path.join(root, d)}")
    entries.sort()
    return [{"path": p, "sha256": file_sha(os.path.join(PACK, p))} for p in entries]


# ---------------------------------------------------------------- run records
os.makedirs(WORK, exist_ok=True)
for stage, name in (("check", "check.json"), ("preview", "preview.json"), ("preview", "release.sha256")):
    if not s3_get(f"{stage}/{EXEC_ID}/{name}", os.path.join(WORK, stage, name)):
        raise Stop(f"the run record {stage}/{name} is missing")
check = json.load(open(os.path.join(WORK, "check", "check.json")))
preview = json.load(open(os.path.join(WORK, "preview", "preview.json")))
if preview.get("sha") != SHA or preview.get("execution") != EXEC_ID:
    raise Stop("Preview recorded another sha or execution")
recorded_pkg = open(os.path.join(WORK, "preview", "release.sha256")).read().strip()
if recorded_pkg != preview.get("releasePackageSha256"):
    raise Stop("Preview's two records of the release package hash differ")

pkg_dir = os.path.join(WORK, "release")
if not s3_get_dir(f"build/{EXEC_ID}/release/", pkg_dir):
    raise Stop("the release package is missing")


def dir_hash(d):
    lines = []
    for root, _dirs, files in os.walk(d):
        for n in files:
            full = os.path.join(root, n)
            lines.append(("./" + os.path.relpath(full, d).replace(os.sep, "/"), file_sha(full)))
    lines.sort()
    return sha256_bytes("".join(f"{h}  {p}\n" for p, h in lines).encode())


if dir_hash(pkg_dir) != recorded_pkg:
    raise Stop("the release package differs from the one Preview recorded")


def pkg_json(name):
    with open(os.path.join(pkg_dir, name), encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- git data from the bundle
bundle = os.path.join(WORK, "source.bundle")
if not s3_get(f"build/{EXEC_ID}/source.bundle", bundle):
    raise Stop("Build left no source bundle")
repo = os.path.join(WORK, "rel.git")
env_git = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")


def git(*args, check=True):
    return run(["git", "-C", repo, *args], check=check, env=env_git)


run(["git", "init", "--quiet", "--bare", repo], env=env_git)
git("fetch", "--quiet", "--no-tags", bundle, "HEAD:refs/heads/rel")
if git("rev-parse", "refs/heads/rel").stdout.decode().strip() != SHA:
    raise Stop("the bundled commit is not the released commit")
TREE = git("rev-parse", f"{SHA}^{{tree}}").stdout.decode().strip()


def commit_exists(sha):
    return HEX40.match(sha or "") is not None and git("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


def is_ancestor(a, b):
    return git("merge-base", "--is-ancestor", a, b, check=False).returncode == 0


def changed_paths(a, b):
    out = git("diff-tree", "-r", "--name-status", "-z", "--no-renames", a, b).stdout.decode("utf-8", "replace").split("\0")
    paths = []
    i = 0
    while i + 1 < len(out):
        paths.append(out[i + 1])
        i += 2
    return paths


def blob(sha, path):
    r = git("cat-file", "blob", f"{sha}:{path}", check=False)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


# ---------------------------------------------------------------- trigger
def trigger():
    pname = E.get("PIPELINE_NAME", "")
    doc = aws("codepipeline", "get-pipeline-execution", "--pipeline-name", pname, "--pipeline-execution-id", EXEC_ID, check=False) if pname else None
    if not doc:
        # Decide's role must be allowed to read its own execution; until it is the run is MANUAL (rule A cannot be proven).
        return {"kind": "unreadable", "variables": {}, "rollback": None}
    ex = doc.get("pipelineExecution", {})
    variables = {v["name"]: v.get("resolvedValue", "") for v in ex.get("variables", [])}
    ttype = (ex.get("trigger") or {}).get("triggerType", "")
    if ex.get("executionType") == "ROLLBACK":
        kind = "rollback"
    elif ttype in ("WebhookV2", "Webhook"):
        kind = "push"
    else:
        kind = f"other:{ttype or 'unknown'}"
    return {"kind": kind, "variables": variables, "rollback": None}


# ---------------------------------------------------------------- GitHub (CI evidence, no token)
GITHUB = E.get("GITHUB_API", "https://api.github.com").rstrip("/")


def gh(path):
    req = urllib.request.Request(GITHUB + path, headers={"Accept": "application/vnd.github+json", "User-Agent": "rovara-release-decide"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise Stop(f"GitHub answered HTTP {e.code} for {path.split('?')[0]}")
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise Stop(f"GitHub could not be read ({type(e).__name__})")


def slim_run(run_doc, jobs, check_runs):
    return {
        "id": run_doc.get("id"), "path": run_doc.get("path"), "event": run_doc.get("event"), "status": run_doc.get("status"), "conclusion": run_doc.get("conclusion"),
        "head_sha": run_doc.get("head_sha"), "head_commit": {"tree_id": (run_doc.get("head_commit") or {}).get("tree_id")},
        "repository": {"full_name": (run_doc.get("repository") or {}).get("full_name")},
        "head_repository": {"full_name": (run_doc.get("head_repository") or {}).get("full_name")},
        "jobs": [{"name": j.get("name"), "status": j.get("status"), "conclusion": j.get("conclusion"), "head_sha": j.get("head_sha")} for j in jobs],
        "checkRuns": [{"name": c.get("name"), "conclusion": c.get("conclusion"), "app": {"slug": (c.get("app") or {}).get("slug")}} for c in check_runs],
    }


def worth_caching(run_doc, ci):
    """Only evidence the evaluator would plausibly accept is cached (a cache hit skips the API): right repo, workflow and head repository, success, every required job green from github-actions.
    The evaluator still judges whatever is read back, so a poisoned cache can only ever be as good as these checks plus the evaluator's own (and only Decide can write it)."""
    if run_doc.get("path") != f".github/workflows/{ci['workflowFile']}" or run_doc.get("status") != "completed" or run_doc.get("conclusion") != "success":
        return False
    if (run_doc.get("repository") or {}).get("full_name") != ci["repo"] or (run_doc.get("head_repository") or {}).get("full_name") != ci["repo"]:
        return False
    for name in ci["requiredJobs"]:
        if not any(j.get("name") == name and j.get("conclusion") == "success" for j in run_doc.get("jobs", [])):
            return False
        if not any(c.get("name") == name and c.get("conclusion") == "success" and (c.get("app") or {}).get("slug") == "github-actions" for c in run_doc.get("checkRuns", [])):
            return False
    return True


def ci_evidence(tree):
    ci = pipeline_cfg["ci"]
    repo_name, wf = ci["repo"], ci["workflowFile"]
    cache_key = f"ci-cache/{repo_name.replace('/', '_')}/{tree}.json"
    cache_file = os.path.join(WORK, "ci-cache.json")
    if s3_get(cache_key, cache_file):
        try:
            cached = json.load(open(cache_file))
            fresh = time.time() - cached.get("cachedAtEpoch", 0) < 6 * 3600
            if fresh and cached.get("tree") == tree and any(worth_caching(r, ci) for r in cached.get("runs", [])):
                return {"apiError": None, "runs": cached["runs"]}
        except ValueError:
            pass
    deadline = time.time() + float(E.get("CI_WAIT_MINUTES", "60")) * 60
    poll = float(E.get("CI_POLL_SECONDS", "300"))
    while True:
        try:
            listing = gh(f"/repos/{repo_name}/actions/workflows/{wf}/runs?per_page=100")
            matching = [r for r in listing.get("workflow_runs", []) if (r.get("head_commit") or {}).get("tree_id") == tree]
            runs = []
            pending = False
            for r in matching:
                if r.get("status") != "completed":
                    pending = True
                    continue
                jobs = gh(f"/repos/{repo_name}/actions/runs/{r['id']}/jobs?per_page=100").get("jobs", [])
                crs = gh(f"/repos/{repo_name}/commits/{r['head_sha']}/check-runs?per_page=100").get("check_runs", [])
                runs.append(slim_run(r, jobs, crs))
            if any(worth_caching(x, ci) for x in runs) or (not pending and runs):
                break
            if time.time() >= deadline:
                break
        except Stop as e:
            return {"apiError": str(e), "runs": []}
        time.sleep(poll)
    good = [x for x in runs if worth_caching(x, ci)]
    if good:
        body = json.dumps({"tree": tree, "cachedAtEpoch": time.time(), "runs": good})
        tmp = os.path.join(WORK, "ci-cache.out")
        open(tmp, "w").write(body)
        run(["aws", "s3", "cp", "--only-show-errors", tmp, f"s3://{BUCKET}/{cache_key}", "--region", REGION], check=False)
    return {"apiError": None, "runs": runs}


# ---------------------------------------------------------------- assemble
def unaudited_auto_runs():
    keys = s3_list("decide/")
    execs = sorted({k.split("/")[1] for k in keys if k.endswith("/decision.json")})[-200:]
    deployed = {k.split("/")[1] for k in s3_list("release/") if k.endswith("/deploy.json")}
    audited = {k.split("/")[1] for k in s3_list("89/") if k.endswith("/audit-RESULT.md")}
    n = 0
    for ex in execs:
        if ex == EXEC_ID or ex not in deployed or ex in audited:
            continue
        tmp = os.path.join(WORK, f"other-decision-{ex}.json")
        if s3_get(f"decide/{ex}/decision.json", tmp):
            try:
                if json.load(open(tmp)).get("verdict") == "AUTO":
                    n += 1
            except ValueError:
                pass
    return n


def assemble():
    sts = aws("sts", "get-caller-identity")
    account = sts["Account"]
    installed = ssm(f"{PREFIX}/{KIND}-installed")
    if not installed or not HEX40.match(installed):
        raise Stop("there is no installed sha pointer yet (the first release goes by hand)")
    holds_doc = aws("ssm", "get-parameters-by-path", "--path", f"{PREFIX}/{KIND}-hold/", "--recursive", check=False)
    if holds_doc is None:
        raise Stop("the HOLD parameters could not be read")
    holds = [p["Name"] for p in holds_doc.get("Parameters", [])]
    if ssm(f"{PREFIX}/{KIND}-hold") is not None:
        holds.append(f"{PREFIX}/{KIND}-hold")  # a bare hold parameter counts too (Check, Guard and Deploy agree)
    trig = trigger()

    # which commit range, which direction
    rollback_input = None
    if MODE == "rollback":
        last_good = ssm(f"{PREFIX}/{KIND}-last-good")
        if not last_good or not HEX40.match(last_good):
            raise Stop("a rollback needs the last-good pointer")
        target, current = last_good, installed
        if target != SHA:
            raise Stop("a rollback must be run for exactly the last-good sha")
        if not commit_exists(current):
            raise Stop("the installed commit is not in the bundle")
        floors = [ln.split()[1] for ln in policy_files["rollback-floor.txt"].splitlines() if ln.strip() and not ln.strip().startswith("#") and ln.split()[0] == KIND]
        if E.get("PRIOR_AUTO_ROLLBACKS", "") == "":
            raise Stop("PRIOR_AUTO_ROLLBACKS is not set for a rollback")
        rollback_input = {
            "lastGoodSha": last_good,
            "floorAncestry": {f: (commit_exists(f) and is_ancestor(f, target)) for f in floors},
            "targetIsAncestorOfInstalled": is_ancestor(target, current),
            "priorAutoRollbacksThisHold": int(E["PRIOR_AUTO_ROLLBACKS"]),
        }
        # the paths and release notes of the range the rollback would UNDO (target..installed), with the notes read at the installed sha
        paths = changed_paths(target, current)
        notes_at = current
        trig = dict(trig, kind="rollback" if trig["kind"] in ("rollback", "push") else trig["kind"], rollback=rollback_input)
    else:
        trig = dict(trig, rollback=None)
        have_installed = commit_exists(installed)
        paths = changed_paths(installed, SHA) if have_installed else []
        notes_at = SHA
    ancestry = {"installedIsAncestorOfSha": commit_exists(installed) and is_ancestor(installed, SHA)}

    note_globs = [glob_re(g) for g in policy.get("releaseNotesGlobs", [])]
    release_notes = [{"path": p, "text": blob(notes_at, p)} for p in paths if any(g.match(p) for g in note_globs)]
    lock = None
    npm = None
    lock_path = policy["lockfile"]["path"]
    if lock_path in paths and MODE == "push":
        lock = {"old": blob(installed, lock_path), "new": blob(SHA, lock_path)}
        npm = json.loads(pkg_json("npm-ci-dry-run.json")) if os.path.exists(os.path.join(pkg_dir, "npm-ci-dry-run.json")) else None

    # stacks, read from CloudFormation itself
    by_stack = {c["stack"]: c for c in preview.get("changeSets", [])}
    stacks = []
    record_sets = []
    for stack_name in pipeline_cfg["stacks"]:
        rec = by_stack.get(stack_name)
        if rec is None:
            continue
        cs = aws("cloudformation", "describe-change-set", "--stack-name", stack_name, "--change-set-name", CS_NAME, "--include-property-values")
        if cs.get("ChangeSetId") != rec["changeSetId"]:
            raise Stop(f"{stack_name}: the change set in CloudFormation is not the one Preview recorded")
        if cs.get("NextToken"):
            raise Stop(f"{stack_name}: the change set was not read to the end")
        new_t = aws("cloudformation", "get-template", "--stack-name", stack_name, "--change-set-name", CS_NAME, "--template-stage", "Original")["TemplateBody"]
        live_t = aws("cloudformation", "get-template", "--stack-name", stack_name, "--template-stage", "Original")["TemplateBody"]
        live_p = aws("cloudformation", "describe-stacks", "--stack-name", stack_name)["Stacks"][0].get("Parameters", [])
        stacks.append({"stackName": stack_name, "changeSet": cs, "liveTemplate": live_t, "newTemplate": new_t, "liveParameters": live_p})
        record_sets.append({
            "stack": stack_name, "changeSetName": CS_NAME, "changeSetId": cs["ChangeSetId"], "status": cs.get("Status"), "noChanges": bool(rec.get("noChanges")),
            "templateSha256": canon_sha(json.dumps(new_t)),
        })

    # images: ECR is asked directly; Build's file says only which are "built" and which "reused" (bound by the package hash)
    images = []
    for img in json.loads(pkg_json("images.json")):
        d = aws("ecr", "describe-images", "--repository-name", img["repo"], "--image-ids", f"imageDigest={img['digest']}", check=False)
        details = (d or {}).get("imageDetails") or []
        images.append({"repo": img["repo"], "digest": img["digest"], "source": img.get("source", ""), "tags": (details[0].get("imageTags") or []) if details else [], "inEcr": bool(details)})

    gate_dir = os.path.join(WORK, "gates")
    s3_get_dir(f"gates/{EXEC_ID}/gates/", gate_dir)
    gates = []
    if os.path.isdir(gate_dir):
        for n in sorted(os.listdir(gate_dir)):
            if n.endswith(".json"):
                gates.append(json.load(open(os.path.join(gate_dir, n))))

    last_exec = ssm(f"{PREFIX}/{KIND}-last-good-execution")
    last_answers = last_overrides = None
    if last_exec and re.match(r"^[0-9a-f-]{36}$", last_exec):
        a, o = os.path.join(WORK, "lg-answers.json"), os.path.join(WORK, "lg-overrides.json")
        if s3_get(f"build/{last_exec}/release/answers.json", a) and s3_get(f"build/{last_exec}/release/overrides.json", o):
            last_answers, last_overrides = open(a).read(), open(o).read()

    pin = ssm(f"{PREFIX}/policy-pin") or "missing"
    doc = {
        "pipeline": KIND, "sha": SHA, "previousInstalledSha": installed, "tree": TREE, "now": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {"accountId": account, "region": REGION}, "checkMode": check.get("mode", "unknown"), "holdParameters": holds,
        "unauditedAutoRuns": unaudited_auto_runs(), "trigger": trig, "ancestry": ancestry,
        "policyFiles": policy_files, "policyManifest": pack_manifest(), "policyPin": pin,
        "changedPaths": paths, "releaseNotes": release_notes, "stacks": stacks, "images": images, "gates": gates,
        "ci": ci_evidence(TREE) if MODE == "push" else {"apiError": None, "runs": []},
        "answers": {"lastGood": last_answers, "current": pkg_json("answers.json")},
        "overrides": {"lastGood": last_overrides, "current": pkg_json("overrides.json")},
    }
    if lock is not None:
        doc["lock"] = lock
        doc["npmCiDryRun"] = npm
    record = {"execution": EXEC_ID, "sha": SHA, "tree": TREE, "releasePackageSha256": recorded_pkg, "changeSets": record_sets, "assets": preview.get("assets", []), "mode": MODE, "policyPin": pin}
    return doc, record


def main(input_path, record_path):
    doc, record = assemble()
    with open(input_path, "w") as f:
        json.dump(doc, f)
    with open(record_path, "w") as f:
        json.dump(record, f, indent=1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    try:
        main(*sys.argv[1:])
    except Stop as e:
        sys.stderr.write(f"DECIDE-INPUT-STOP: {e}\n")
        sys.exit(4)
