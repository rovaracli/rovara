"""Gate 15 (upgrade mode): simulate the LIVE deploy role for the actions each non-Metadata row of this run's change sets needs.

Ported from the Mac script 15-old-role-sim (23o copy, upgrade branch only). Read-only: iam simulate-principal-policy, iam get-role, cloudformation list-stack-resources,
through the plain `aws` CLI of the stage's role. No `--query` (the answers are parsed here), no secret value, no account id literal: the account, region, role, boundary and
bootstrap bucket arrive as arguments from gates/15-role-sim.sh (which gets them from lib/common.sh).

Usage: role_sim.py <preview dir> <account> <region> <environment> <deploy role name> <boundary arn> <out dir> <bootstrap bucket> <part>:<stack> [<part>:<stack> ...]
  <preview dir>  holds <stack>.changeset.json and <stack>.template.json for every stack
Exit 0 only when 0 actions are not allowed, 0 rows are unmapped and at least one case was simulated; otherwise 1 (each failing case prints a line with [FAIL]).
"""
import json, os, subprocess, sys

pdir, acct, region, env_name, role_name, boundary_arn, out, bootstrap = sys.argv[1:9]
STACKS = dict(x.split(":", 1) for x in sys.argv[9:])
PARTS = list(STACKS)
ALLOWED = {("iam", "simulate-principal-policy"), ("iam", "get-role"), ("cloudformation", "list-stack-resources")}


def aws(*args):
    assert (args[0], args[1]) in ALLOWED, f"not allowed: {args[:2]}"
    env = dict(os.environ, AWS_PAGER="")
    r = subprocess.run(["aws", *args, "--region", region, "--output", "json"], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        return None, (r.stderr.strip().splitlines() or ["error"])[-1]
    return (json.loads(r.stdout) if r.stdout.strip() else {}), ""


def decisions(doc, with_boundary=True):
    """EvaluationResults as (action, decision, boundary-allowed) triples."""
    out_ = []
    for r in (doc or {}).get("EvaluationResults", []) or []:
        b = (r.get("PermissionsBoundaryDecisionDetail") or {}).get("AllowedByPermissionsBoundary")
        out_.append([r.get("EvalActionName"), r.get("EvalDecision"), b] if with_boundary else [r.get("EvalActionName"), r.get("EvalDecision")])
    return out_


def role_info(name):
    doc, err = aws("iam", "get-role", "--role-name", name)
    if doc is None or not (doc.get("Role") or {}).get("Arn"):
        return None, err or "no role in the answer"
    return [doc["Role"]["Arn"], (doc["Role"].get("PermissionsBoundary") or {}).get("PermissionsBoundaryArn")], ""


role, err = role_info(role_name)
if not role:
    sys.exit(f"STOP: cannot read role {role_name}: {err}")
role_arn, live_boundary = role
print(f"deploy role {role_arn}; its boundary: {live_boundary or 'NONE'}")
if not role_arn.startswith(f"arn:aws:iam::{acct}:role/"):
    sys.exit("STOP: the deploy role is not in this account")


def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit(f"STOP: cannot read {path} ({type(e).__name__}): the gate fails closed")


cs = {p: load(f"{pdir}/{STACKS[p]}.changeset.json") for p in PARTS}
tpl = {p: load(f"{pdir}/{STACKS[p]}.template.json").get("Resources") or {} for p in PARTS}
phys_cache = {}


def phys(part):
    if part not in phys_cache:
        res, err = aws("cloudformation", "list-stack-resources", "--stack-name", STACKS[part])
        if res is None:
            sys.exit(f"STOP: cannot list {STACKS[part]}: {err}")
        phys_cache[part] = {r["LogicalResourceId"]: (r.get("PhysicalResourceId"), r.get("ResourceType")) for r in res.get("StackResourceSummaries", [])}
    return phys_cache[part]


def role_arn_of(name):
    got, err = role_info(name)
    if got is None:
        print(f"  note: get-role {name} failed: {err}")
        return None
    return got[0]


def resolve(v, part):
    """A template value to a real string: literal, Ref of a change-set parameter, GetAtt <lid>.Arn of a live resource, or a simple Fn::Sub."""
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and "Ref" in v:
        params = {x["ParameterKey"]: x.get("ParameterValue") for x in cs[part].get("Parameters", [])}
        return params.get(v["Ref"])
    if isinstance(v, dict) and "Fn::GetAtt" in v:
        lid, attr = v["Fn::GetAtt"]
        pid, typ = phys(part).get(lid, (None, None))
        if attr != "Arn" or not pid:
            return None
        if typ == "AWS::IAM::Role":
            return role_arn_of(pid)
        return pid if pid.startswith("arn:") else None
    if isinstance(v, dict) and isinstance(v.get("Fn::Sub"), str):
        s = v["Fn::Sub"].replace("${AWS::AccountId}", acct).replace("${AWS::Region}", region).replace("${AWS::Partition}", "aws")
        return None if "${" in s else s
    return None


# Which changed properties each mapped type may carry (anything else is UNMAPPED: its API actions are not simulated here).
LAMBDA_PROPS = {"Code", "Environment", "Timeout", "MemorySize", "Description", "Handler", "Runtime", "Tags"}
SSM_PROPS = {"Value", "Description", "Tags"}
TASKDEF_PROPS = {"ContainerDefinitions"}
SERVICE_PROPS = {"TaskDefinition"}
POLICY_PROPS = {"PolicyDocument"}
policy_roles = []   # (row, role arn, new policy document): read by the INFO check at the end

cases, unmapped = [], []   # (label, resource, actions, ctx)
informational = []   # (label, resource, actions, ctx) simulated and PRINTED but not gating; added 2026-11-19 (backup 15-old-role-sim.sh.bak-20261119-b20adds)
access_rows = []     # access-stack IAM rows: deployed with the OPERATOR's own credentials, not the deploy role; printed, not simulated
for part in PARTS:
    for c in cs[part].get("Changes", []):
        rc = c.get("ResourceChange", {})
        act, lid, typ, pid = rc.get("Action"), rc.get("LogicalResourceId"), rc.get("ResourceType"), rc.get("PhysicalResourceId") or ""
        repl = rc.get("Replacement") in ("True", "Conditional")
        scope = set(rc.get("Scope") or [])
        props = {(d.get("Target") or {}).get("Name") for d in rc.get("Details", []) if (d.get("Target") or {}).get("Attribute") == "Properties"}
        if act == "Remove" and typ == "AWS::CDK::Metadata":
            continue
        if act == "Modify" and not repl and not (scope - {"Metadata"}):
            continue  # Metadata-only: CloudFormation makes no API call for it
        if act == "Modify" and not repl and typ == "AWS::CDK::Metadata":
            continue  # the CDKMetadata analytics string: no API call outside CloudFormation
        where = f"{part}/{lid} {act}{' REPLACE' if repl else ''} {typ}"
        if "Properties" in scope and not {p for p in props if p} and part == "access":
            # COPY 2026-11-19 (0.5.31 prep; original 15-old-role-sim.sh untouched): an access-stack row whose Scope says Properties but whose
            # Details name no property (CloudFormation phantom on AWS::IAM::ManagedPolicy DefaultPermissionsBoundary while the template
            # Properties equal live) is an operator-credential row like every other access IAM row: printed as ACCESS-OPERATOR, not simulated.
            access_rows.append(f"{where}: Properties in Scope but no named property in Details (phantom; compare the access template with live)"); continue
        if "Properties" in scope and not {p for p in props if p}:
            unmapped.append(f"{where}: Properties change with no named property in Details; cannot map it"); continue
        res = tpl[part].get(lid, {}).get("Properties") or {}
        if act == "Modify" and not repl and typ == "AWS::Lambda::Function" and props <= LAMBDA_PROPS and pid:
            fn = f"arn:aws:lambda:{region}:{acct}:function:{pid}"
            cases.append((where, fn, ["lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:ListTags", "lambda:TagResource"], []))
            fr = resolve(res.get("Role"), part)
            if not fr:
                unmapped.append(f"{where}: cannot resolve its Role for iam:PassRole"); continue
            cases.append((where + " (its role)", fr, ["iam:PassRole"], []))
            if "Code" in props:
                code = res.get("Code") or {}
                bkt, key = resolve(code.get("S3Bucket"), part), code.get("S3Key")
                if not (bkt and isinstance(key, str)):
                    unmapped.append(f"{where}: Code is not an S3Bucket/S3Key the script can resolve"); continue
                if bkt != bootstrap:
                    unmapped.append(f"{where}: code bucket {bkt} is not the bootstrap bucket {bootstrap}"); continue
                cases.append((where + " (code asset)", f"arn:aws:s3:::{bkt}/{key}", ["s3:GetObject"], []))
        elif act == "Modify" and not repl and typ == "AWS::SSM::Parameter" and props <= SSM_PROPS and pid:
            arn = f"arn:aws:ssm:{region}:{acct}:parameter{pid if pid.startswith('/') else '/' + pid}"
            cases.append((where, arn, ["ssm:PutParameter", "ssm:GetParameters", "ssm:AddTagsToResource"], []))
        elif act == "Modify" and typ == "AWS::ECS::TaskDefinition" and props <= TASKDEF_PROPS and pid.startswith("arn:"):
            # Register/Deregister/DescribeTaskDefinition take no resource-level ARN (IAM authorizes them on "*"); simulating them on the
            # revision ARN matches no statement and reads as implicitDeny even for ecs:* on "*" (seen 2026-11-17), so "*" is the real check.
            cases.append((where + f" (register; deregister old {pid.rsplit('/', 1)[-1]})", "*", ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition"], []))
            fam = res.get("Family")
            if res.get("Tags"):
                if not isinstance(fam, str):
                    unmapped.append(f"{where}: Tags but no literal Family"); continue
                cases.append((where + " (tags)", f"arn:aws:ecs:{region}:{acct}:task-definition/{fam}:*", ["ecs:TagResource"], []))
            for k in ("TaskRoleArn", "ExecutionRoleArn"):
                if k in res:
                    ra = resolve(res[k], part)
                    if not (ra and ra.startswith(f"arn:aws:iam::{acct}:role/")):
                        unmapped.append(f"{where}: cannot resolve {k} to a role ARN"); continue
                    cases.append((f"{where} (PassRole {k})", ra, ["iam:PassRole"], []))
        elif act == "Modify" and not repl and typ == "AWS::ECS::Service" and props <= SERVICE_PROPS and pid.startswith("arn:"):
            cases.append((where, pid, ["ecs:UpdateService", "ecs:DescribeServices"], []))
        elif (act == "Modify" and not repl and typ == "AWS::IAM::Policy" and props <= POLICY_PROPS) or (act == "Add" and typ == "AWS::IAM::Policy"):
            # Add (2026-11-18, 0.5.27 #966): a NEW inline role policy is the same PutRolePolicy call; its rollback is DeleteRolePolicy.
            # Added 2026-11-17 (0.5.26; backup 15-old-role-sim.sh.bak-20261117-iampolicy): an inline role policy whose document changes is
            # rewritten with iam:PutRolePolicy (read back with GetRolePolicy) on each role it names. The role's REAL boundary is sent as
            # iam:PermissionsBoundary, so IamRequireBoundary is evaluated as IAM would for that role. Users/groups are not mapped.
            if res.get("Users") or res.get("Groups"):
                unmapped.append(f"{where}: names users or groups; only roles are mapped"); continue
            roles = res.get("Roles") or []
            if not roles:
                unmapped.append(f"{where}: no Roles"); continue
            for rref in roles:
                rlid = rref.get("Ref") if isinstance(rref, dict) else None
                rname = phys(part).get(rlid, (None, None))[0] if rlid else (rref if isinstance(rref, str) else None)
                rp_new = (tpl[part].get(rlid, {}).get("Properties") or {}) if rlid else {}
                if rname is None and act == "Add" and tpl[part].get(rlid, {}).get("Type") == "AWS::IAM::Role" and isinstance(rp_new.get("RoleName"), str) and isinstance(rp_new.get("Path"), str):
                    # Added 2026-11-19: the role is created by this same change set (Add row), so it has no live ARN yet; its ARN is path + RoleName,
                    # its boundary is the install's boundary (the role resource carries it).
                    narn = f"arn:aws:iam::{acct}:role{rp_new['Path']}{rp_new['RoleName']}"
                    cases.append((f"{where} (PutRolePolicy on NEW role {rp_new['RoleName']}; the environment boundary)", narn,
                                  ["iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy"], [("iam:PermissionsBoundary", boundary_arn)]))
                    continue
                got, err = role_info(rname) if rname else (None, "no name")
                if not got:
                    unmapped.append(f"{where}: cannot resolve role {rref} ({err})"); continue
                rarn, rb = got
                policy_roles.append((where, rarn, res.get("PolicyDocument") or {}))
                cases.append((f"{where} (PutRolePolicy on {rarn.split(':role/')[-1]}; its boundary {(rb or 'NONE').rsplit('/', 1)[-1]})", rarn,
                               ["iam:PutRolePolicy", "iam:GetRolePolicy"] + (["iam:DeleteRolePolicy"] if act == "Add" else []), [("iam:PermissionsBoundary", rb)] if rb else []))
        # Added 2026-11-17 (batch 13 upgrade prep; backup 15-old-role-sim.sh.bak-20261117-b13adds): the Add rows of an upgrade whose names are
        # literals in the template. Each maps to the create call CloudFormation makes, its read-back/tag calls and the delete a failed create's
        # rollback makes, on the real ARN the resource will have. Anything else stays UNMAPPED.
        elif act == "Add" and typ == "AWS::ECR::Repository" and isinstance(res.get("RepositoryName"), str):
            arn = f"arn:aws:ecr:{region}:{acct}:repository/{res['RepositoryName']}"
            cases.append((where, arn, ["ecr:CreateRepository", "ecr:TagResource", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability",
                                       "ecr:DescribeRepositories", "ecr:ListTagsForResource", "ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy", "ecr:DeleteRepository"], []))
        elif act == "Add" and typ == "AWS::SSM::Parameter" and isinstance(res.get("Name"), str):
            n = res["Name"]
            arn = f"arn:aws:ssm:{region}:{acct}:parameter{n if n.startswith('/') else '/' + n}"
            cases.append((where, arn, ["ssm:PutParameter", "ssm:GetParameters", "ssm:AddTagsToResource", "ssm:ListTagsForResource", "ssm:DeleteParameter"], []))
        elif act == "Add" and typ == "AWS::SecretsManager::Secret" and isinstance(res.get("Name"), str):
            arn = f"arn:aws:secretsmanager:{region}:{acct}:secret:{res['Name']}-AbCdEf"
            cases.append((where, arn, ["secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret"], []))
        elif act == "Add" and typ == "AWS::SecretsManager::ResourcePolicy" and isinstance(res.get("SecretId"), dict) and "Ref" in res["SecretId"] \
                and isinstance((tpl[part].get(res["SecretId"]["Ref"], {}).get("Properties") or {}).get("Name"), str):
            sname = tpl[part][res["SecretId"]["Ref"]]["Properties"]["Name"]
            arn = f"arn:aws:secretsmanager:{region}:{acct}:secret:{sname}-AbCdEf"
            cases.append((where + f" (on {sname})", arn, ["secretsmanager:PutResourcePolicy", "secretsmanager:GetResourcePolicy", "secretsmanager:ValidateResourcePolicy", "secretsmanager:DeleteResourcePolicy"], []))
        elif act == "Add" and typ == "AWS::ApiGatewayV2::Route" and isinstance(res.get("ApiId"), dict) and "Ref" in res["ApiId"]:
            api = phys(part).get(res["ApiId"]["Ref"], (None, None))[0]
            if not api:
                unmapped.append(f"{where}: cannot resolve ApiId {res['ApiId']}"); continue
            cases.append((where + f" (api {api})", f"arn:aws:apigateway:{region}::/apis/{api}/routes", ["apigateway:POST", "apigateway:GET"], []))
            cases.append((where + f" (api {api}, rollback)", f"arn:aws:apigateway:{region}::/apis/{api}/routes/*", ["apigateway:GET", "apigateway:DELETE"], []))
        # Added 2026-11-23 (install-20261123o, Code 0.5.48 webhook W3; this COPY only, the shared 15- script is untouched): the stage's RouteSettings Modify and the webhook alarm Add.
        elif act == "Modify" and not repl and typ == "AWS::ApiGatewayV2::Stage" and props <= {"RouteSettings"} and isinstance(res.get("ApiId"), dict) and "Ref" in res["ApiId"] and isinstance(res.get("StageName"), str):
            api = phys(part).get(res["ApiId"]["Ref"], (None, None))[0]
            if not api:
                unmapped.append(f"{where}: cannot resolve ApiId {res['ApiId']}"); continue
            cases.append((where + f" (api {api}, stage {res['StageName']})", f"arn:aws:apigateway:{region}::/apis/{api}/stages/{res['StageName']}", ["apigateway:PATCH", "apigateway:GET"], []))
        elif act == "Add" and typ == "AWS::CloudWatch::Alarm" and isinstance(res.get("AlarmName"), str):
            arn = f"arn:aws:cloudwatch:{region}:{acct}:alarm:{res['AlarmName']}"
            cases.append((where, arn, ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource", "cloudwatch:ListTagsForResource", "cloudwatch:DeleteAlarms"], []))
        # Added 2026-11-18 (0.5.27 batch 14+15 upgrade prep; backup 15-old-role-sim.sh.bak-20261118-b1415adds).
        elif act == "Modify" and not repl and typ == "AWS::SecretsManager::Secret" and props <= {"SecretString", "Description", "Tags"} and pid.startswith("arn:"):
            cases.append((where, pid, ["secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"], []))
        elif act == "Modify" and not repl and typ == "AWS::StepFunctions::StateMachine" and props <= {"DefinitionString", "DefinitionSubstitutions"} and pid.startswith("arn:"):
            cases.append((where, pid, ["states:UpdateStateMachine", "states:DescribeStateMachine", "states:ListTagsForResource"], []))
            sr = resolve(res.get("RoleArn"), part)
            if not sr:
                unmapped.append(f"{where}: cannot resolve its RoleArn for iam:PassRole"); continue
            cases.append((where + " (its role)", sr, ["iam:PassRole"], []))
        elif act == "Add" and typ == "AWS::Scheduler::Schedule" and isinstance(res.get("GroupName"), dict) and "Ref" in res["GroupName"]:
            grp = phys(part).get(res["GroupName"]["Ref"], (None, None))[0]
            tr = resolve((res.get("Target") or {}).get("RoleArn"), part)
            if not (grp and tr):
                unmapped.append(f"{where}: cannot resolve GroupName or Target.RoleArn"); continue
            cases.append((where + f" (group {grp})", f"arn:aws:scheduler:{region}:{acct}:schedule/{grp}/*", ["scheduler:CreateSchedule", "scheduler:GetSchedule", "scheduler:DeleteSchedule"], []))
            cases.append((where + " (target role)", tr, ["iam:PassRole"], []))
        # Added 2026-11-18 (0.5.28 batch 16+17+18 upgrade prep; backup 15-old-role-sim.sh.bak-20261118-b1618adds).
        elif act == "Modify" and not repl and typ == "AWS::Route53Resolver::FirewallDomainList" and props <= {"Domains"} and pid:
            arn = f"arn:aws:route53resolver:{region}:{acct}:firewall-domain-list/{pid}"
            cases.append((where, arn, ["route53resolver:UpdateFirewallDomains", "route53resolver:GetFirewallDomainList", "route53resolver:ListFirewallDomains", "route53resolver:ListTagsForResource"], []))
        elif act == "Modify" and not repl and typ == "AWS::EC2::EIP" and not {p for p in props if p} and scope <= {"Metadata", "DeletionPolicy", "UpdateReplacePolicy"}:
            # DeletionPolicy/UpdateReplacePolicy only: CloudFormation stores the policy itself and makes no EC2 write; the read-back is DescribeAddresses on "*".
            cases.append((where + " (policy-only; read-back)", "*", ["ec2:DescribeAddresses"], []))
        elif act == "Modify" and not repl and typ == "AWS::KMS::Key" and props <= {"KeyPolicy"} and pid:
            # simulate-principal-policy checks the role's identity policy + boundary; the key policy's own root statement must also allow it (checked separately).
            arn = f"arn:aws:kms:{region}:{acct}:key/{pid}"
            cases.append((where, arn, ["kms:PutKeyPolicy", "kms:GetKeyPolicy", "kms:DescribeKey", "kms:ListResourceTags"], []))
        # Added 2026-11-19 (0.5.30 batch 20+21 upgrade prep; backup 15-old-role-sim.sh.bak-20261119-b20adds).
        elif act == "Add" and typ == "AWS::SQS::Queue" and isinstance(res.get("QueueName"), str):
            arn = f"arn:aws:sqs:{region}:{acct}:{res['QueueName']}"
            cases.append((where, arn, ["sqs:CreateQueue", "sqs:TagQueue", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes", "sqs:ListQueueTags", "sqs:DeleteQueue"], []))
        elif act == "Add" and typ == "AWS::SQS::QueuePolicy" and res.get("Queues"):
            for q in res["Queues"]:
                qn = (tpl[part].get(q.get("Ref") if isinstance(q, dict) else None, {}).get("Properties") or {}).get("QueueName")
                if not isinstance(qn, str):
                    unmapped.append(f"{where}: cannot resolve queue {q}"); continue
                cases.append((where + f" (on {qn})", f"arn:aws:sqs:{region}:{acct}:{qn}", ["sqs:SetQueueAttributes", "sqs:GetQueueAttributes"], []))
        elif act == "Add" and typ == "AWS::IAM::Role" and isinstance(res.get("RoleName"), str) and isinstance(res.get("Path"), str):
            rarn = f"arn:aws:iam::{acct}:role{res['Path']}{res['RoleName']}"
            cases.append((where, rarn, ["iam:CreateRole", "iam:TagRole", "iam:GetRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole"],
                          [("iam:PermissionsBoundary", boundary_arn)]))
            # CloudFormation's own existence check on a fixed-name role uses the PATH-LESS ARN (the 0.5.30 access stack adds a statement for it):
            # INFO only, because the live (old) role is expected to deny it until the access stack is deployed.
            informational.append((where + " (CFN fixed-name check, path-less ARN; new access statement IamFixedNameRolesNotYetCreated)",
                                  f"arn:aws:iam::{acct}:role/{res['RoleName']}", ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:DeleteRole"], []))
        elif act == "Add" and typ == "AWS::ECR::RepositoryCreationTemplate":
            # No resource-level ARN is simulated for the template actions ("*"); the ECR service-linked role is created on first use (new access statement EcrTemplateServiceLinkedRole).
            cases.append((where, "*", ["ecr:CreateRepositoryCreationTemplate", "ecr:DescribeRepositoryCreationTemplates", "ecr:UpdateRepositoryCreationTemplate", "ecr:DeleteRepositoryCreationTemplate"], []))
            informational.append((where + " (ECR template service-linked role; new access statement EcrTemplateServiceLinkedRole)",
                                  f"arn:aws:iam::{acct}:role/aws-service-role/ecr.amazonaws.com/AWSServiceRoleForECRTemplate", ["iam:CreateServiceLinkedRole"], [("iam:AWSServiceName", "ecr.amazonaws.com")]))
        elif act == "Modify" and not repl and typ == "AWS::Logs::LogGroup" and props <= {"ResourcePolicyDocument"}:
            cases.append((where, "*", ["logs:PutResourcePolicy", "logs:DescribeResourcePolicies"], []))
        elif part == "access" and act == "Modify" and not repl and typ in ("AWS::IAM::Role", "AWS::IAM::ManagedPolicy") and props <= {"Policies", "PolicyDocument", "AssumeRolePolicyDocument"}:
            access_rows.append(f"{where} (changed: {sorted(props)})")
        else:
            unmapped.append(f"{where} (changed properties: {sorted(p for p in props if p)}): no action map; simulate it by hand or add a mapping")

# The IAM probe (corrected 2026-11-17): a role under /agentx/<env>/ WITH the boundary context, so IamRequireBoundary is evaluated, not skipped.
PROBE = f"arn:aws:iam::{acct}:role/agentx/{env_name}/x"
cases.append((f"IAM probe: role/agentx/{env_name}/* with iam:PermissionsBoundary=the environment boundary", PROBE,
              ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary"],
              [("iam:PermissionsBoundary", boundary_arn)]))
cases.append((f"IAM probe: iam:PassRole on role/agentx/{env_name}/*", PROBE, ["iam:PassRole"], []))

os.makedirs(out, exist_ok=True)
open(f"{out}/cases.txt", "w").write("\n".join(f"{c[0]} | {c[1]} | {','.join(c[2])} | ctx={c[3]}" for c in cases) + "\n")
rows, bad = [], 0
for label, res, actions, ctx in cases:
    for i in range(0, len(actions), 20):
        cmd = ["iam", "simulate-principal-policy", "--policy-source-arn", role_arn, "--action-names", *actions[i:i + 20], "--resource-arns", res]
        if ctx:
            cmd += ["--context-entries", *[f"ContextKeyName={k},ContextKeyValues={v},ContextKeyType=string" for k, v in ctx]]
        got, err = aws(*cmd)
        if got is None:
            rows.append((label, "ERROR", f"({err})", "-")); bad += 1
            continue
        returned = decisions(got)
        asked = set(actions[i:i + 20])
        for a, d, b in returned:
            rows.append((label, d, a, b))
            bad += d != "allowed"
        for a in sorted(asked - {r[0] for r in returned}):
            # an action the simulation did not answer for is not allowed (fail closed)
            rows.append((label, "NO-ANSWER", a, "-")); bad += 1
for label, d, a, b in rows:
    print(f"  {'ok  ' if d == 'allowed' else '[FAIL] DENY'} {d:13s} {a:36s} boundary={b} {label}")
for u in unmapped:
    print(f"  [FAIL] UNMAPPED {u}")
print(f"upgrade cases simulated: {len(rows)}; not allowed: {bad}; unmapped rows: {len(unmapped)}")
for a in access_rows:
    print(f"  ACCESS-OPERATOR (not simulated against the deploy role; the access stack is deployed with the operator's own credentials; read the rows and run the new-role simulation): {a}")
for label, res, actions, ctx in informational:
    cmd = ["iam", "simulate-principal-policy", "--policy-source-arn", role_arn, "--action-names", *actions, "--resource-arns", res]
    if ctx:
        cmd += ["--context-entries", *[f"ContextKeyName={k},ContextKeyValues={v},ContextKeyType=string" for k, v in ctx]]
    got, err = aws(*cmd)
    for a, d in (decisions(got, False) if got is not None else [["-", f"ERROR {err}"]]):
        print(f"  INFO(non-gating) {d:13s} {a:36s} {label}")


# INFO only (does not gate; added 2026-11-17): for each changed inline policy, would the ROLE it is on actually get its secretsmanager
# grants once written? simulate-principal-policy on that role with the NEW document added (--policy-input-list), so the role's real
# boundary is applied. Sample ARNs: "??????" -> "-AbCdEf" suffix kept, "*" -> "c1/T1-AbCdEf".
def flat_arn(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and "Fn::Join" in v:
        sep, parts = v["Fn::Join"]
        pseudo = {"AWS::Partition": "aws", "AWS::Region": region, "AWS::AccountId": acct}
        outp = []
        for x in parts:
            if isinstance(x, str): outp.append(x)
            elif isinstance(x, dict) and x.get("Ref") in pseudo: outp.append(pseudo[x["Ref"]])
            else: return None
        return sep.join(outp)
    return None
for where, rarn, doc in policy_roles:
    stmts = []
    for s in doc.get("Statement", []):
        rs = s.get("Resource"); rs = rs if isinstance(rs, list) else [rs]
        fr = [flat_arn(r) for r in rs]
        if all(fr) and any(":secretsmanager:" in r for r in fr):
            stmts.append({**{k: v for k, v in s.items() if k != "Resource"}, "Resource": fr})
    if not stmts:
        continue
    pin = json.dumps({"Version": "2012-10-17", "Statement": stmts})
    for s in stmts:
        acts = s["Action"] if isinstance(s["Action"], list) else [s["Action"]]
        for r in s["Resource"]:
            sample = r.replace("??????", "AbCdEf").replace("*", "c1/T1-AbCdEf")
            got, err = aws("iam", "simulate-principal-policy", "--policy-source-arn", rarn, "--policy-input-list", pin, "--action-names", *acts,
                           "--resource-arns", sample)
            for a, d, b in (decisions(got) if got is not None else [[",".join(acts), "ERROR", err]]):
                print(f"  INFO {d:13s} {a:36s} boundary={b} role {rarn.split(':role/')[-1]} on {sample}")
sys.exit(1 if (bad or unmapped or not rows) else 0)
