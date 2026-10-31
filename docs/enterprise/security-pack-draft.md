# Rovara Enterprise edition: security pack (draft)

Draft of 30 October 2026, for owner review. Written for the security reviewers of a company that will run Rovara in its own AWS account. It is generic: any company's code host, build system, tracker and sign-in are "plug-ins", and nothing here depends on one customer.

How to read it. Every statement carries one of four marks.

- **[Built]** exists in the code today. The evidence line names where.
- **[Built, not deployed]** the code or infrastructure definition exists and passes its tests, but it has not run in a customer-shaped account. The install proof (tasks N10a to N10e) is what turns it into [Built].
- **[Designed]** decided and written down, not built. The task that builds it is named.
- **[Not built]** no design or no work yet. Said so on purpose.

Marks are about the software at commit `fd7cd3c35` plus the Wave 1 work of the enterprise foundations design. "Not yet tested" means exactly that. This pack makes no claim of certification (SOC 2, ISO 27001 or similar) and no claim of isolation beyond what is listed.

## 1. Summary on one page

- Rovara is meant to run entirely in your AWS account, with your code, your task text and your model calls staying there. The install is the existing `rovara init` and `deploy` with an `enterprise` network profile (task N1). [Built, not deployed] That holds with `rovaraEnterpriseInternetEgress=none` (the default for the Enterprise profile) and after the follow-ups in section 14; the broker's own functions do not yet run inside your VPC (section 2).
- Nothing is sent to Rovara by default. [Built, not deployed] What exists is a static scan of the source for hard-coded hosts, with a test that fails when a new one appears (`docs/enterprise/outbound.md`, task N4). By its own header it is the floor of what the code can reach: it misses hosts built at run time or read from settings. The proof is the flow-log check in the install proof (task N10c). The known exceptions are in section 2.
- Models are your own Bedrock, reached through a private endpoint in your VPC. Another provider is used only if your admin adds it. [Built, not deployed] (endpoint); [Designed] (model proxy and image supply, task N2).
- People sign in with your identity provider. Group claims decide their Rovara role, and a person in no mapped group has no access, owners included. An owner is never granted by a mapping. Sessions last at most 8 hours, so removing someone from a group takes effect within 8 hours. [Built] (evaluator, store and session cap, task I1 and the edition table); [Designed] (wiring into sign-in, which waits for task E3 to turn off the other sign-in methods; SAML task I4).
- Rovara merges only when a person with the right role presses Merge. The merge call is made by Rovara's service identity and is audited. [Built]
- **Who runs it.** Under the managed-VPC agreement, Rovara runs upgrades and watches the install. For that, your account holds one standing operator role that you approve and can suspend at any moment, whose every use lands in your CloudTrail and in your alert topic. The operator can trigger only the deployment of a signed bundle whose hash you approved; your own deploy role does the work. [Built, not deployed] as infrastructure code and tests (task N6, rescoped from a break-glass role; see appendix A and `docs/enterprise/operator-role.md`, which also say what this does not promise). The command that places an approved bundle and the deploy path from the approval bucket are [Designed].
- What is not ready yet is in section 14. It is a short list and it is honest.

## 2. Architecture and data flows

```text
people (your SSO) --> private web/API endpoint (your network)                       [Designed: spec 002 private endpoint]
                           |
                      control plane (broker, audit, Team record) --> DynamoDB / S3 (your KMS keys)
                           | signed push invocations
                      workers (EC2, one per workspace; security group: no route to the whole internet)
                           |--> VPC interface endpoints (13 services plus S3): bedrock-runtime, bedrock, sts, kms, logs, monitoring,
                           |      ecr.api, ecr.dkr, secretsmanager, ssm, sqs, states, ec2, s3 (and gateway endpoints for DynamoDB and S3)
                           |--> model proxy --> your Bedrock (same account) or your own model endpoint
                           '--> hosts your network team approves (code host, build system, registries, tool servers)
```

Network paths (source, destination, port, why).

| From | To | Port | Why | Status |
| --- | --- | --- | --- | --- |
| Workers, dispatcher, session manager, model proxy, model access function | VPC interface endpoints (13 services plus S3) and gateway endpoints for S3 and DynamoDB | 443 | Reach AWS APIs without leaving the VPC. Every endpoint has a policy that admits only principals of your account (and, for S3 and DynamoDB, only your account's resources, with the two documented AWS-owned read exceptions). Only the private subnets may reach the endpoints. | Residual: the other endpoints check the calling principal but not the resource's account, so a worker can reach another account's queue or log group if that resource allows it; the worker role's own permissions are the only limit there (STS is left open because cross-account roles are legitimate). [Built, not deployed] (`infra/lib/vpc-endpoints.ts`) |
| Workers, model proxy, model access function, Slack orchestrator | the VPC range and the private ranges your network team lists | 443 | Everything else they need, including the control plane's address | [Built, not deployed] (`rovaraEnterpriseEgressCidrs`: private ranges only, at most 20, none wider than a /8; a public range needs `rovaraEnterpriseAllowPublicRanges=true`) |
| Control plane | Workers | 8080 | Signed invocations | [Built] |
| Workers and the other groups above | the whole internet | none | Not allowed in the Enterprise profile | [Built, not deployed] (test: none of the security groups of the foundation, the control plane's model proxy and model access function, or the Slack orchestrator has a `0.0.0.0/0` or IPv6 egress rule) |
| Agent machines | DNS | n/a | Names resolve only through the DNS firewall, in allow-list mode. The list starts from your endpoint names and your load balancers; no public package, image, model or chat host is on it. Your admin adds what they approve. | [Built, not deployed] |

NAT gateways are off by default in the Enterprise profile (the install has no internet route); `rovaraEnterpriseInternetEgress=nat` adds them. With no internet route at least one approved range is required, because workers must reach the control plane. [Built, not deployed]

Full list of outbound hosts the code can name, with what an Enterprise install does about each: `docs/enterprise/outbound.md`. [Built] Two findings in it matter to a reviewer:

1. The audit anchor asks two public timestamp authorities by default. The Enterprise profile refuses that default at synth: the install must name its own (`agentxAuditTsa=custom`) or switch it off. [Built, not deployed]
2. The DNS firewall allow-list of an Enterprise install starts from its own endpoint names, not from the public default list. Adding your registries, code host and build system to it from your settings is [Designed] (it rides on tasks N8 and N9).

Known gaps in the sealed network, stated plainly:

- **The broker's own Lambda functions are not in your VPC.** They reach the internet directly, so no security group, DNS firewall or flow log applies to them. The broker is where features that call out (custom model endpoints, tool servers, connectors, webhooks) live, so this is the largest gap in the sealed network. Moving them into the VPC, behind the endpoints and the DNS firewall, is [Designed] (the design change is written up for the next build wave) and not built. Until then this pack does not claim that nothing can leave.
- A worker reaches the control plane's callback address over HTTPS. That address is public today, and API Gateway's addresses are not a stable range you can approve. The install therefore needs a private path to the control plane (an `execute-api` interface endpoint with a private API restricted to your endpoint, or an internal load balancer in front of the broker). [Designed], not built. This blocks the install proof.
- The Lambda functions of the control plane outside the model path, and the endpoints they would need once inside the VPC (`execute-api`, `sns`, `events`, `codebuild`, `lambda`), are listed in `infra/lib/vpc-endpoints.ts` for the day they move.

## 3. Where data lives, and for how long

One row per kind of data. "Store" is where it sits in your account. Keys are yours (KMS in your account).

| Data | Store | Retention | Status |
| --- | --- | --- | --- |
| Your code, in workspaces | One encrypted EBS volume per workspace, under a KMS key in your account; the instance is terminated when idle and the volume stays until the workspace is closed | Until the workspace is closed | [Built] (`infra/lib/ec2-workers.ts`, `production-foundation.ts`) |
| Companies, projects, tasks, plans, approvals, settings | DynamoDB in your account, point-in-time recovery on | Your policy; recovery window 35 days | [Built] |
| Task text, comments, model conversations, records of what each task did | The install's own stores [verify which store holds which, before this goes to a reviewer] | Set per source by an admin | [Built] |
| Browser-test screenshots | The install's artifact bucket | 30 days | [Built] |
| Company AI keys, if you supply any | Secrets Manager (encrypted), referenced by name | Until removed | [Built] |
| Audit ledger | A per-company hash-chained ledger, sealed copies in a locked, versioned bucket; personal details sealed per person | 1,096 days on a production install (a test install uses a 1-day lock) | [Built] |
| Team record: raw text (default: about 30 days), distilled facts and lessons (long-term), the lake | Hot index plus a data lake, one partition per workspace | Enterprise default C: raw text about 30 days, distilled knowledge long-term; set per source by an admin | [Designed] (learning v2 and Team record design, not built) |
| Telemetry | Not collected | Not applicable | [Designed] as opt-in, after the pilot; off by default |

Deleting at the source (for example a message) deletes everywhere, and every record keeps the source's permission snapshot. [Designed]

## 4. Models

- Models run on your Bedrock, in your account, through the `bedrock-runtime` endpoint in your VPC. No other provider is used unless your admin adds one as a model source, and each such host then needs an entry on the egress allow-list. [Built, not deployed] (endpoint); the model proxy using its own role in your account and its image coming from your registry is [Designed] (task N2).
- Today the model proxy's image is pulled from a public registry at deploy time. A sealed install cannot start it until N2 puts the image in the release bundle. [Not built]
- A custom model endpoint (your own gateway) is [Designed] (task N8): Enterprise only, https only, usable only after its model check passes. The Public edition refuses the field.
- Each model is qualified by a model check before use. [Built]
- Bedrock's own data terms are AWS's; see AWS's documentation of Bedrock data protection [verify the page before sending]. We do not re-verify them.

## 5. Sandbox

- One instance per workspace, on its own encrypted volume, never shared with another company. [Built]
- The instance metadata service is IMDSv2 only with one hop, and the boot script closes the metadata address for every container and every non-root process. [Built] (`infra/lib/ec2-workers.ts`).
- Agent commands run in a locked-down container: no Docker socket, privileges dropped. [Built]
- Egress from workers: see section 2. [Built, not deployed]
- **Open: agent shells can reach listeners on the host (TF16).** In your VPC the internal network is the target, so this must be closed before an Enterprise install holds real code. [Not built] (register row 102).
- **Open: dev-container projects run with fewer restrictions than other projects (TF13, TF19).** A fix date is not set. [Not built]

## 6. Identity and access

- Sign-in: OpenID Connect with your provider [Built]. SAML [Designed] (task I4). The hosted sign-in methods (email code, Google, GitHub, Slack) are a feature row that is off in the Enterprise edition [Built] (`publicSignInMethods`); the routes that obey the row are [Designed] (task E3). **The mapping is not wired into sign-in until E3 turns the other methods off**, because a person removed from a group could otherwise sign in through another linked method and keep their last role.
- Group mapping: an admin maps your provider's groups (a claim that carries groups, never a profile field such as email or name; later a SAML attribute) to an org role and project roles. It is read at every sign-in. A missing, unreadable or invalid mapping refuses the sign-in; so does a missing or malformed claim; a person in no mapped group has no access; matching is exact and case-sensitive. [Built] (task I1: `packages/broker/src/developer/group-mapping.ts`, with tests that fail without each rule). Wiring it into the sign-in route is [Designed].
- Sessions last at most 8 hours in the Enterprise edition, so a group removal takes effect within 8 hours at the latest. [Built] (the cap is in the edition policy; the session code applies it when the mapping is wired).
- An owner is never granted by mapping, and owners go through the mapping like everyone else: an owner removed from every mapped group is refused. Only when the mapping itself is broken (not set up, unreadable, or the provider stops sending the claim) may one of at most two named owners sign in as break-glass. That sign-in writes an `sso.break_glass_used` audit event, raises an alert, lasts one hour and needs a sign-in no older than five minutes. [Built] as decision logic (task I1); the audit event, alert and session limits are applied by the route, which is [Designed].
- Roles: owner, admin, member; project roles maintainer, contributor, viewer. [Built]
- Auditor, a read-only role that can browse and export the audit log. [Designed] (task I2).
- Fresh sign-in for approvals, using the provider's `auth_time`. [Built]
- What Rovara acts as at your code host, build system and tracker. Default: a non-human identity you own, with every write attributed to the person who asked and the person who approved (commit trailer, change-request text, audit link). Optional: a short-lived credential the person grants for one task, never used to approve or merge, only where the host offers delegation. Never a person's password or session copied into Rovara. [Designed] (rules built as pure functions in task P1; attribution is task I3).
- Two-person rules for risky changes exist and have been tested mostly in tests, not yet live with two people. [Built]

## 7. PII handling

- Browser and end-to-end tests use made-up data, never production data. [Designed] (not enforced yet)
- Stored records are scrubbed for known credential shapes; this is not a guarantee. Keep secrets out of repositories and task text. [Built]
- A live check that nothing sensitive leaks into stored records or model-visible text (the leak check) has not been run. [Not built]
- A person's details in the audit log are sealed under a per-person key; deleting the key erases them while the record of what happened stays. [Built]
- Erasing a person everywhere, and the permission snapshot on every Team record row. [Designed]

## 8. Injection and agent safety

- Text from outside (comments, build logs, tracker items, tool results) is data, never an instruction. It reaches a model inside labelled blocks, and authority comes only from Rovara roles. [Built] for CI output; [Designed] as a rule for every plug-in (port rules in `contracts/src/plugins`).
- Writes to outside systems go through a write gate with an audit event. Tracker status changes are limited to a set an admin chooses. [Built] (gate); [Designed] (tracker limits).
- Rovara merges only when a person with the right role presses Merge. The merge call is made by Rovara's service identity and is audited. [Built]
- Learned lessons: cited facts from trusted sources apply automatically, broad behaviour needs one person, anything touching reviewers, checks or security needs two. Outsiders' text is never used. [Designed] (learning v2).
- Adapters are in-tree only, reviewed, and covered by the signed bundle. No code is loaded at run time. [Built] as a rule (the port design); signing is [Designed] (tasks N2, N3).

## 9. Audit

- Hash-chained ledger, owner and admin read, asynchronous export, and a third-party verifier that recomputes the chain. [Built]
- Auditor role, and continuous export to your own S3. [Designed] (task I2 and the export design).
- The operator role's every use is in your CloudTrail, and an alert goes to your topic on each assumption. [Built, not deployed] (task N6).

## 10. Supply chain and upgrades

- Release bundle: a manifest of SHA-256 hashes of every artifact, the CDK assets, every container image (including the model proxy's), migration notes, and a signature from a Rovara KMS key whose public key is pinned in the installed tool and published. [Designed] (task N2).
- `rovara upgrade --bundle` verifies the signature and hashes first, runs pre-checks, takes a restore point, then deploys in the existing order. Any changed byte is refused before anything changes. [Designed] (task N3).
- The upgrade tool refuses to install an older release. [Built]
- Rollback: redeploy the previous bundle and restore to the restore point. It has not been rehearsed. [Not built] (rehearsal is task N10e).
- Software bill of materials: an open-source bill of materials exists in the platform spec. [verify it is current before sending]
- **Who runs upgrades.** Rovara does, in your agreed change window, under the managed-VPC agreement, by starting the deployment of a bundle you approved through your own deploy role (appendix A). Before each upgrade you receive the release notes and the bundle's manifest hash and approve it. [Designed]

## 11. Shared responsibility

| | You | Rovara |
| --- | --- | --- |
| AWS account, network, routes, endpoints, allow-lists | Yes | Supplies the definitions and the list of what is needed |
| Identity provider, group membership, break-glass owner | Yes | Evaluates the mapping |
| KMS keys, backups, backup policy | Yes | Supplies the restore runbook; rehearses it with you |
| Approving the operator role, suspending it, reviewing its use | Yes | Uses it only as agreed; reports every use |
| Operating system patch window for workers | Yes | Ships the worker image |
| Software, fixes, security advisories | No | Yes |
| Running upgrades | Approves each | Runs them |
| Choosing and adding model sources and plug-ins | Yes | Supplies the adapters |

## 12. Incident and vulnerability process

Contacts, notice times and how you report a problem are not set. [Not built] Owner to decide before an install holds real code. Recommendation: named people on both sides, a first notice before a full explanation, a written account afterwards, and the notice window written into the agreement.

## 13. Questionnaire answers

A standard vendor questionnaire gets honest answers: "not certified", "not yet tested" where that is true, and the marks above. We will not answer a question the marks do not support. [Designed] (the answer sheet is task S1's follow-up, once the owner has reviewed this pack).

## 14. Open items before an install holds real code

0. Build a private path to the control plane and move the broker's Lambda functions into the VPC (section 2), or state plainly to the customer that the broker can reach the internet.
1. Close TF16 (agent shells reaching host listeners) for the Enterprise profile.
2. Close the dev-container gap (TF13, TF19), or refuse dev-container projects in Enterprise.
3. Build the release bundle and the signed upgrade (N2, N3), including the model proxy image.
4. Build the operator role as designed in appendix A (N6, rescoped), and rehearse suspending it.
5. Refuse the default public timestamp authorities in the Enterprise edition, or require an explicit choice (E2).
6. Prove the sealed network in a test account: an allowed call works, a blocked one fails, flow logs show nothing to Rovara (N10a, N10c).
7. Run the leak check, a restore drill, a rollback rehearsal and a deletion rehearsal, and write down what they measured.
8. Turn off the hosted sign-in methods for Enterprise (E3), then wire group mapping into sign-in; add SAML if your provider needs it, and add the Auditor role (E3, I1 wiring, I4, I2). Make `ROVARA_EDITION` the only source of the edition at run time (E2).
9. Set contacts, notice times and the vulnerability process (section 12).

## Appendix A. Operator access under the managed-VPC agreement

Decision (owner, 2026-10-30): Rovara operates the install and runs upgrades. That needs a standing role in your account, approved and audited by you, not break-glass access only. The design file's earlier text "no standing access; break-glass only" is superseded by that decision. Shape approved by the owner on 31 October 2026 and built as task N6 (which was a break-glass role, disabled by default): [Built, not deployed], described in full in `docs/enterprise/operator-role.md`. It has not run in an account, and it needs your security team's agreement per install.

**What the pack promises, and what it does not.** The promise that Rovara cannot read your content does not rest on a list of denied actions on one role, because code deployed to your account runs under the application's own roles, which can read every store. It rests on three things together:

1. **Only signed bundles you approved are deployed.** The operator can start a deployment of a release bundle, and only one whose signature verifies and whose manifest hash you have approved. The operator does not deploy arbitrary code or templates.
2. **A deploy role you own does the work.** The CloudFormation changes run under a service role in your account that you own and can change. The operator's role may pass only that role, and may not create or alter any other role.
3. **The operator's own role is narrow, and your controls sit above it.**

**The operator role.**

- Created by the install's infrastructure code, only if you set `rovaraOperatorAccess=enabled`.
- Trust: one named Rovara operator role, with an external id you hold, multi-factor authentication required. Each session must set `sts:SourceIdentity` to the name of the person using it. Source identity is kept when roles are chained, so your CloudTrail names the person at every step. Sessions last at most one hour.
- Allowed: start a deployment of an approved bundle through your deploy role; read stack events and metrics; read logs from the log groups that hold no content, which are listed in the install and exclude every group a worker or task writes task text to.
- Explicitly denied, and not removable by the operator: any write to IAM, `iam:PassRole` except your deploy role, `ssm:StartSession` and `ssm:SendCommand` on workers, `ec2:GetConsoleOutput`, `lambda:GetFunction*` and `lambda:UpdateFunctionCode`, `secretsmanager:*`, data-plane reads on the stores that hold code, tasks, plans, conversations and the Team record, and KMS decryption of their keys (their key policies do not name the operator).
- **Suspend switch.** `rovaraOperatorAccess=suspended` makes the role deny everything. The switch lives in a service control policy or a permissions boundary that you own, which neither the operator role nor your deploy role can change. The operator cannot redeploy the stack that holds it.
- **Your control.** Optional change windows (outside them the role denies), and your approval of each bundle's manifest hash before we run it.
- **Audit.** Your CloudTrail records every assumption and action under the person's name. An event rule sends each assumption to your alert topic. A Rovara audit event names the person and the reason. We give you a monthly report of uses.
- **Reading content.** Needs a separate grant from you that expires, with its own approval. It is not part of the standing role.

Log reads are the one place content could leak by accident (a log line that carries task text), which is why they are limited to named log groups and why the list is part of what you review.

## Appendix B. What we ask of your team (generic)

1. The AWS account for the install, and your process for connecting it to your code host, build system, sign-in provider and tool servers.
2. Your rule for non-human identities: may a service identity push and open change requests? If not, which short-lived, per-person mechanism is approved?
3. For each plug-in: the documentation or client libraries for the system (create and update a change request, read comments and approvals, events or polling), and how a build runs outside a developer's machine.
4. A sandbox repository, package and tracker folder we may write to while building the adapters.
5. One engineer as the contact for two or three short sessions per adapter, and the person who signs off this pack.
6. How you will define success, and 20 to 30 past tasks to test against.
