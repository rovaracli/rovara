# Model proxy TLS (decision 110, MODEL-PROXY-TLS)

Cloud's model proxy (LiteLLM on ECS Fargate, `infra/lib/model-proxy.ts`) sits behind an internal Application Load Balancer. Until 0.5.15 its
callers used plain http inside the VPC: `http://internal-…<region>.elb.amazonaws.com:4000` for inference (workers, the Slack orchestrator, the
broker's hand-out to a task) and `:4001` for LiteLLM's management routes (the model access function only).

Public Rovara Code refuses a plain-http model server that is not on the same computer (`modelProviderAddressProblem`, no private-address
exception), and so will the A3 LiteLLM adapter. The proxy therefore has to serve HTTPS before A3 is wired.

## Options

| Option | What it is | Monthly cost | Work and risk |
|---|---|---|---|
| **(a) Public ACM certificate, split-horizon name** (chosen) | A public ACM certificate for a name under a domain the install owns (for example `model-proxy.staging.rovara.dev`), validated by DNS in that domain's public zone. A private hosted zone of exactly that name, attached to the install VPC, holds an alias record to the internal load balancer. | Certificate: $0 (ACM public certificates are free, and ACM renews them). Private zone: $0.50. Alias queries to an ELB: $0. **About $0.50 a month.** | Small. CloudFormation requests and validates the certificate itself. Needs a public zone in the account (or a certificate the company brings). Every client already trusts the Amazon root CA, so nothing changes on workers or in containers. |
| (b) ACM Private CA | A private CA issuing the proxy's certificate. | About $400 a month per CA (general-purpose mode), plus per-certificate fees. | Not acceptable for this: it costs more than the whole proxy, and every client would still need the private CA installed. |
| (c) Self-signed or install-owned CA imported into ACM | Rovara makes a CA and a server key, imports the certificate into ACM, and every client trusts the CA explicitly (`NODE_EXTRA_CA_CERTS` or a pinned CA). | About $0.40 a month for the Secrets Manager secret. | Large. CloudFormation cannot import a certificate, so it needs a custom resource that generates keys, stores the CA key in Secrets Manager and re-imports before expiry (imported certificates do not renew). Every client (worker host, task containers, the orchestrator, the model access function, the A3 adapter) must be given the CA. A missed rotation stops every model call. |

**Recommendation: (a).** It is the cheapest secure option, the certificate renews itself, and no client needs a new trust anchor. When a company's
DNS is not in the install's account, the same design takes an issued ACM certificate the company brings (`rovaraModelProxyTlsCertificateArn`), for
example one they validated in their own DNS.

Simpler variant not built (owner question): put the alias record in the **public** zone instead of a private one. The internal load balancer's own
name already resolves publicly to its private addresses, so a public record reveals nothing new, and the deploy role would need no
`CreateHostedZone`/`DeleteHostedZone`. Decision 110 names a private zone, so that is what is built.

## What is built

Settings (CDK context, read once in `infra/lib/app.ts`; parsing and checks in `infra/lib/model-proxy-tls.ts`):

| Context key | Meaning |
|---|---|
| `rovaraModelProxyTlsName` | The proxy's DNS name, lower case, at most 64 characters, not an `amazonaws.com` name. Unset: the plain-http proxy exactly as before (templates unchanged). |
| `rovaraModelProxyTlsZoneId` | The public hosted zone (in this account) of the name's parent domain. CloudFormation requests the certificate and writes the `_<hash>.<name>` validation record there. |
| `rovaraModelProxyTlsCertificateArn` | Instead of the zone: an issued certificate in the install's region that covers the name. Exactly one of the two. |
| `rovaraModelProxyLegacyHttp` | `keep`: also keep the old plain-http listeners for one release (see rollout). Unset or `off`: none. |

With the name set:

- **Listeners.** HTTPS on 443 (inference: the same R48 rules, a 403 by default and POST to the inference paths only) and HTTPS on 8443
  (management, every path). Both use `ELBSecurityPolicy-TLS13-1-2-Res-2021-06` (TLS 1.3 and 1.2, forward-secret AEAD ciphers only). The load
  balancer still talks plain http to the LiteLLM tasks on 4000, inside the VPC, between two security groups that admit only each other (TLS
  ends at the load balancer).
- **No plain-http path.** Without `keep`, the HTTP listeners on 4000 and 4001 and their security group rules are gone.
- **Name.** A private hosted zone named exactly the proxy's name (so nothing else of the company's domain is shadowed inside the VPC), with an
  alias A record to the load balancer. Outside the VPC the name does not resolve.
- **URLs.** Workers (the `model-proxy-url` SSM parameter), the broker (`AGENTX_NAMES` code `mh`, built into `https://<name>`; `mp` is no longer
  passed), the model access function (`https://<name>:8443`) and the Slack orchestrator (the `ModelProxyUrl` output it is deployed with) all get
  https. The SSM parameter, the model access function and the broker depend on the listeners and the record, so nobody is handed the new URL
  before it answers.
- **Security groups.** Same groups, same scope: the load balancer admits 443 from the client groups (workers, orchestrator) and 8443 from the
  model access function only. Group descriptions are left as they were on purpose: a changed description replaces a group.
- **DNS firewall.** The name is on the install's allow list (cloud and Enterprise). ENTERPRISE-ELB-RDS-ALLOW-BUG is fixed in the same change:
  the Enterprise list allowed `*.elb.<region>.amazonaws.com`, which matches Network Load Balancer names only; an internal ALB is
  `internal-…<region>.elb.amazonaws.com`, so it is now `*.<region>.elb.amazonaws.com`, plus the missing Aurora name `*.<region>.rds.amazonaws.com`.
- **Deploy role.** A managed policy of its own (`ModelProxyTlsDeployPolicy`, under 6,144 characters) on the CloudFormation service role, only when
  the name is set, so the role's inline policy (capped at 10,240) does not grow. It allows: requesting a certificate for exactly the name, tagged
  with the environment, and managing only certificates with that tag; the validation CNAME (`_*.<name>`) in the public zone only; creating a
  hosted zone and associating it with a VPC; reading, tagging, deleting and disassociating hosted zones (Route 53 has no tag conditions for zones;
  AWS refuses to delete a zone holding records, so the reach is empty zones); A records named exactly `<name>`. With a brought certificate:
  `acm:DescribeCertificate` on that certificate only.

## Rollout (staging first)

Tasks that started before the upgrade hold the old `http://…:4000` address for their whole run. To not break them:

1. Upgrade with the name, the zone (or certificate) and `rovaraModelProxyLegacyHttp=keep`. The stack creates the certificate (CloudFormation
   waits a few minutes for DNS validation), the private zone and record, and the HTTPS listeners; keeps the HTTP ones; and switches every URL
   to https. New tasks use https; running tasks finish on http.
2. When no task that started before step 1 is still running (the longest task timeout), upgrade again without `keep`. That removes the two
   HTTP listeners, the HTTP listener rule and the 4000/4001 security group rules. Nothing is replaced.

A fresh install sets the name from the start and never has HTTP listeners.

What the staging upgrade creates or changes (step 1):

- created: `ModelProxyTlsCertificate` (ACM, plus its validation CNAME in the public zone), `ModelProxyTlsPrivateZone`, `ModelProxyTlsAliasRecord`,
  `ModelProxyTlsListener`, `ModelProxyTlsInferenceRoutes`, `ModelProxyTlsManagementListener`, the 443 and 8443 security group rules (control
  plane and Slack stacks), `ModelProxyTlsDeployPolicy` (access stack);
- changed in place: the `model-proxy-url` parameter, the broker's and the model access function's environment, the `ModelProxyUrl` output (and
  so the orchestrator's task definition, a normal ECS rolling deploy), the foundation's DNS firewall allow list;
- replaced: nothing. The load balancer, its security group, the target group and the service are unchanged.

The access stack must be deployed first (it carries the new grants), as on every upgrade.

## Open items

- **Where the setting is kept.** The context has to be passed on every `agentx upgrade`; an upgrade without it synthesizes the plain-http proxy
  again. Before production this should become a recorded install setting (like the Team record's switch, `team-record-switch.ts`) that the CLI
  passes back on every cdk command. Until then the staging upgrade passes the `-c` values itself.
- **Which domain.** Staging's account holds the public zone `rovara.dev` (`Z08286002FKUL2VBSO3MO`); a name such as
  `model-proxy.staging.rovara.dev` works. The production and customer names are the owner's choice.
- TLS between the load balancer and the LiteLLM tasks (end to end) is not built; the hop stays inside the VPC between two locked groups.
