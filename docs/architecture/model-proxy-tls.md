# Model proxy TLS (decision 110, amended by decision 127)

Cloud's model proxy (LiteLLM on ECS Fargate, `infra/lib/model-proxy.ts`) sits behind an internal Application Load Balancer. Until 0.5.15 its
callers used plain http inside the VPC: `http://internal-…<region>.elb.amazonaws.com:4000` for inference (workers, the Slack orchestrator, the
broker's hand-out to a task) and `:4001` for LiteLLM's management routes (the model access function only).

Public Rovara Code refuses a plain-http model server that is not on the same computer (`modelProviderAddressProblem`, no private-address
exception), and so will the A3 LiteLLM adapter. The proxy therefore has to serve HTTPS before A3 is wired.

## Options

| Option | What it is | Monthly cost | Work and risk |
|---|---|---|---|
| **(a) Public ACM certificate, public alias record** (chosen) | A public ACM certificate for a name under a domain the install owns (staging: `model-proxy.staging.rovara.dev`, decision 126), validated by DNS in that domain's public zone, plus an alias A record in the same zone pointing to the internal load balancer. | **$0.** ACM public certificates are free and renew themselves; one more record in an existing zone costs nothing; alias queries to an ELB are free. | Small. CloudFormation requests and validates the certificate. Needs the domain's public zone in the install's account. Every client already trusts the Amazon root CA, so nothing changes on workers or in containers. |
| (b) ACM Private CA | A private CA issuing the proxy's certificate. | About $400 a month per CA (general-purpose mode), plus per-certificate fees. | Not acceptable: it costs more than the whole proxy, and every client would still need the private CA installed. |
| (c) Self-signed or install-owned CA imported into ACM | Rovara makes a CA and a server key, imports the certificate into ACM, and every client trusts the CA explicitly (`NODE_EXTRA_CA_CERTS` or a pinned CA). | About $0.40 a month for the Secrets Manager secret. | Large. CloudFormation cannot import a certificate, so it needs a custom resource that generates keys, keeps the CA key in Secrets Manager and re-imports before expiry (imported certificates do not renew). Every client needs the CA. A missed rotation stops every model call. |

**Chosen: (a).** It is the cheapest secure option, the certificate renews itself, and no client needs a new trust anchor. A company can bring an
issued ACM certificate (`certificateArn`) instead of having one requested; the alias record still goes in its zone.

**Decision 127 (amends 110): public record, not a private zone.** The first build put the name in a private hosted zone attached to the VPC. The
owner chose the public record instead. The internal load balancer's own name already resolves publicly to its private addresses, so a public
record reveals nothing new (the addresses cannot be reached from outside the VPC). It also costs nothing, and the deploy role needs no
`CreateHostedZone`, `DeleteHostedZone` or VPC association, and no grant on any zone but the install's own.

## What is built

The settings are CDK context, read once in `infra/lib/app.ts` and checked in `infra/lib/model-proxy-tls.ts`:

| Context key | Meaning |
|---|---|
| `rovaraModelProxyTlsName` | The proxy's DNS name, lower case, at most 64 characters, not an `amazonaws.com` name. Unset: the plain-http proxy exactly as before (templates unchanged). |
| `rovaraModelProxyTlsZoneId` | Required with the name: the install's public hosted zone (in this account) of the name's parent domain. The alias record goes there, and the validation record of a requested certificate. |
| `rovaraModelProxyTlsCertificateArn` | Optional: an issued certificate in the install's region that covers the name, used instead of requesting one. |
| `rovaraModelProxyLegacyHttp` | `keep`: also keep the old plain-http listeners for one release (see rollout). Unset or `off`: none. |

The install does not pass these by hand. It records them (`agentx --env <env> config set modelProxy.tls "name=…;zoneId=…[;certificateArn=…][;legacyHttp=keep|off]"`,
kept in SSM at `/agentx/<env>/model-proxy-tls`, `packages/cli/src/deploy/model-proxy-tls.ts`), and every cdk command (`agentx upgrade`, its diff and
its parameter synth) passes them back, the way the Team record's switch works. Only an install deployed from source (the cdk engine) can
record it. The prebuilt templates would put the proxy back on plain http, so the CLI refuses that combination.

With the name set:

- **Listeners.** HTTPS on 443 (inference, with the same R48 rules: a 403 by default, and POST to the inference paths only) and HTTPS on 8443
  (management, every path). Both use `ELBSecurityPolicy-TLS13-1-2-Res-2021-06` (TLS 1.3 and 1.2, forward-secret AEAD ciphers only). The load
  balancer still talks plain http to the LiteLLM tasks on 4000. That hop stays inside the VPC, between two security groups that admit only each
  other: TLS ends at the load balancer.
- **No plain-http path.** Without `keep`, the HTTP listeners on 4000 and 4001 and their security group rules are gone.
- **Name.** An alias A record `<name>` in the public zone, pointing to the internal load balancer.
- **URLs.** Every caller gets https:
  - workers, through the `model-proxy-url` SSM parameter;
  - the broker, through `AGENTX_NAMES` code `mh`, which it builds into `https://<name>` (`mp` is no longer passed);
  - the model access function, at `https://<name>:8443`;
  - the Slack orchestrator, through the `ModelProxyUrl` output it is deployed with.

  The SSM parameter, the model access function and the broker depend on the listeners and the record, so nobody is handed the new URL before it
  answers.
- **Security groups.** Same groups, same scope: the load balancer admits 443 from the client groups (workers, orchestrator) and 8443 from the
  model access function only. Group descriptions are left as they were on purpose, because a changed description replaces a group.
- **DNS firewall.** The name is on the install's allow list (cloud and Enterprise).
  - ENTERPRISE-ELB-RDS-ALLOW-BUG is fixed in the same change. The Enterprise list allowed `*.elb.<region>.amazonaws.com`, which matches Network
    Load Balancer names only. An internal ALB is named `internal-…<region>.elb.amazonaws.com`, so the entry is now
    `*.<region>.elb.amazonaws.com`, and the missing Aurora name `*.<region>.rds.amazonaws.com` is added.
  - L2: once TLS is on and the legacy listeners are off, nothing resolves a load balancer's name any more, so the Enterprise list drops
    `*.<region>.elb.amazonaws.com`.
- **Deploy role.** A managed policy of its own (`ModelProxyTlsDeployPolicy`, well under 6,144 characters) is attached to the CloudFormation service
  role, only when the name is set, so the role's inline policy (capped at 10,240) does not grow.
  - Every Route 53 write is `ChangeResourceRecordSets` on `hostedzone/<zoneId>` only. Its conditions name the record, the type and the action
    (`CREATE`, `UPSERT`, `DELETE`), each `ForAllValues` with a `Null: false` guard so a request cannot leave one out:
    - the alias record, `<name>`, type A;
    - the validation record, `_*.<name>`, type CNAME (only when the certificate is requested).
  - The only other Route 53 grants are reads: `GetHostedZone` and `ListResourceRecordSets` on that zone, `GetChange`, and `ListHostedZones`.
  - Certificate Manager: a request for exactly the name, tagged with the environment; afterwards only certificates carrying that tag. With a
    brought certificate, only `acm:DescribeCertificate` on that one ARN.
- **Operator role.** Unchanged. A cdk-engine upgrade is refused for the operator role (it cannot deploy the access stack), so the checks below always
  run with admin credentials, which can read the worker instances.
- **Validation record pattern.** The grant names `_*.<name>`. ACM's documentation calls the label "a long string generated by ACM" and shows
  32-hex examples (`_3639ac514e785e898d2646601fa951d5.example.com.`), but does not promise the length or alphabet, so the pattern is not pinned to
  32 characters: a format change by ACM would otherwise stop every certificate renewal's re-validation write.

## Changing or removing the name (M-1)

The access stack is deployed before the control plane. Without care, a change that removes what the old setting built would drop the deploy role's
grants first, and the control plane's delete of the old record, validation CNAME and certificate would fail or leave them behind. Such a change is
turning TLS off, a new name or zone, or a requested certificate swapped for a brought one.

So `config set modelProxy.tls` keeps the old name as `previous` in the record. The next upgrade passes it as
`-c rovaraModelProxyTlsPreviousName=… -c rovaraModelProxyTlsPreviousZoneId=… -c rovaraModelProxyTlsPreviousCertificate=requested|brought`. The deploy
role then keeps DELETE-only grants, for that upgrade, on the old A record and (if the stack requested the certificate) the old `_*.<name>` CNAME,
plus a tag-scoped `acm:DeleteCertificate`.

After every stack has deployed, the CLI clears `previous`, and the upgrade after that drops the grants. A second change before any upgrade keeps
the first `previous` (that is what is deployed). `config set` also prints the manual cleanup in case the upgrade fails or an older agentx runs it.

## Who may change the setting (L-4)

The setting lives at `/agentx/<env>/model-proxy-tls`, under the environment's settings folder. The operator role may write that folder
(`ssm:PutParameter` on `/agentx/<env>/*`), so an operator can record or change it. A recorded change does nothing until the next upgrade, which
needs admin credentials on the cdk engine and shows the change in its diff (the listeners, the record and the certificate) before anything is
deployed. The M1 refusal stops an upgrade that would take TLS away unless the person passes `--allow-tls-removal`.

## Enterprise (M-2)

`config set modelProxy.tls` is refused on an Enterprise install for now. Its upgrades go through the signed-bundle path (`runBuiltBundleUpgrade`,
`--deploy-approved`, the synth settings of `build-at-approval.ts`), which does not yet carry the setting or run the checks
(DEFERRED-CHECKS MODEL-PROXY-TLS-BUNDLE-PATH).

## Checks before every upgrade (`packages/cli/src/upgrade/run.ts`)

Before anything is prepared or deployed, `agentx upgrade` runs these checks (`assertModelProxyTlsDeploy`):

- **M1, no silent removal.** If the control plane's `ModelProxyUrl` output is `https://` and no TLS setting is recorded, the upgrade is refused.
  `--allow-tls-removal` overrides it. This catches an upgrade from a CLI or a machine that never recorded the setting, and the prebuilt-templates
  engine.
- **L1, no early legacy removal.** Workers keep the proxy address they were given at launch, and a worker lives up to 14 days
  (`SESSION_MAX_LIFETIME_MS`). If the recorded setting has the legacy listeners off, the upgrade is refused while any of the install's pending or
  running worker instances launched before the https address was published. The publish time is the `model-proxy-url` parameter's
  `LastModifiedDate`, taken while that parameter holds `https://<name>`. If it does not hold that yet, every running worker counts.
  `--allow-legacy-http-removal` overrides it. The workers are read only when the legacy listeners are about to go.
- **L3, a domain ACM can validate.** ACM's DNS validation can otherwise hang for up to 72 hours. Before a certificate is first requested (no brought
  certificate, and the name is not yet served), the public DNS is checked: the closest delegated domain above the name must be served by Route 53
  name servers (`*.awsdns-*`), and the closest CAA record set at or above the name, if there is one, must allow `amazon.com`, `amazontrust.com`,
  `awstrust.com` or `amazonaws.com`. A lookup that fails for any other reason refuses too.

## Rollout (staging first)

**Step 1.** Record the setting with `keep`, then upgrade:

```sh
agentx --env staging config set modelProxy.tls "name=model-proxy.staging.rovara.dev;zoneId=Z08286002FKUL2VBSO3MO;legacyHttp=keep"
agentx --env staging upgrade --source <checkout> ...
```

The synth then gets:

```
-c rovaraModelProxyTlsName=model-proxy.staging.rovara.dev -c rovaraModelProxyTlsZoneId=Z08286002FKUL2VBSO3MO -c rovaraModelProxyLegacyHttp=keep
```

What step 1 does to the stacks:

- **Created:**
  - `ModelProxyTlsCertificate` (ACM). Its validation CNAME is written in `rovara.dev`, and CloudFormation waits a few minutes for validation.
  - `ModelProxyTlsAliasRecord` (A `model-proxy.staging.rovara.dev`, in `rovara.dev`).
  - `ModelProxyTlsListener`, `ModelProxyTlsInferenceRoutes` and `ModelProxyTlsManagementListener`.
  - The 443 and 8443 security group rules (control plane and Slack stacks).
  - `ModelProxyTlsDeployPolicy` (access stack).
- **Changed in place:**
  - the `model-proxy-url` parameter;
  - the broker's and the model access function's environment;
  - the `ModelProxyUrl` output, and so the orchestrator's task definition (a normal ECS rolling deploy);
  - the foundation's DNS firewall allow list.
- **Replaced:** nothing. The load balancer, its security group, the target group and the service are unchanged. The old HTTP listeners keep their
  logical ids.

New tasks use https. Workers that were already running finish on http.

**Step 2.** Wait until no worker instance launched before step 1 is still running (at most 14 days; the CLI checks EC2 launch times against the
publish time and refuses until then). Then record `legacyHttp=off` and upgrade again:

```sh
agentx --env staging config set modelProxy.tls "name=model-proxy.staging.rovara.dev;zoneId=Z08286002FKUL2VBSO3MO;legacyHttp=off"
agentx --env staging upgrade --source <checkout> ...
```

The synth then gets:

```
-c rovaraModelProxyTlsName=model-proxy.staging.rovara.dev -c rovaraModelProxyTlsZoneId=Z08286002FKUL2VBSO3MO -c rovaraModelProxyLegacyHttp=off
```

That removes the two HTTP listeners, the HTTP listener rule and the 4000/4001 security group rules, and (Enterprise) the load balancer wildcard
from the DNS list. Nothing is replaced.

A fresh install records the setting without `keep` from the start and never has HTTP listeners. Deploy the access stack first, as on every
upgrade: it carries the new grants.

### 0.5.15 staging runbook notes

- **Watch the first step 1 for the certificate's tags (L-3).** CloudFormation tags the certificate as it requests it, and the grant requires the
  `agentx:env` request tag on `acm:RequestCertificate` and `acm:AddTagsToCertificate`. If ACM's tag-on-create path is authorized differently
  than expected, the certificate create fails with AccessDenied. The control plane stack then rolls back on its own: the new listeners, record
  and URLs are not kept, and the proxy stays on plain http. Report the exact action named in the error before retrying.
- Watch the certificate's validation: it should be issued within minutes. The L3 check has already confirmed that `rovara.dev` is served by
  Route 53 and that no CAA record forbids Amazon.

## Open items

- The Enterprise bundle path (see M-2).

- `agentx upgrade --export` and the Enterprise approve-then-deploy bundle path (`build-at-approval.ts`) do not yet carry the recorded setting or
  run the checks. Enterprise installs need that before they turn TLS on.
- `agentx deploy` (the answers-file path) passes the recorded setting to the synth, but does not run the M1, L1 and L3 checks. Only
  `agentx upgrade` runs them.
- TLS between the load balancer and the LiteLLM tasks (end to end) is not built.
