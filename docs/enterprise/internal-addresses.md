# Internal addresses tasks may reach

From 0.5.15, task sandboxes, dev containers and setup runs run behind a wall: they reach the
internet, but no private address (10.x, 172.16-31.x, 192.168.x, 100.64-127.x), no link-local
address and nothing on the worker itself. That keeps a task away from Rovara's own services and from
your network.

Many companies install packages from an internal server: a private npm, PyPI or Maven mirror, or
Artifactory or Nexus on a private address. Without an entry here, every task that installs from such
a server fails at install time.

## Where it is offered

Internal addresses are an Enterprise setting. They are offered only on an install that routes to
your network: one installed with `rovaraEnterpriseEgressCidrs` (the peered, VPN or Transit Gateway
ranges Rovara's workers can reach). On every other install (all hosted installs) the page isn't
listed and the server refuses changes, because workers have no route to a private network there.

Workers may open TCP 443 to those ranges. A server on another port (Nexus on 8081, say) needs the
port in the install's `rovaraPrivateAddressPorts` (`-c rovaraPrivateAddressPorts=8081,8443`, at most
8 ports). Each port becomes one outbound rule per routed range on the workers' security group,
never toward Rovara's own VPC. The list is fixed at install on purpose: an admin's approval can
never widen a security group, and the broker has no permission to change one. The page shows the
open ports, and an entry on any other port is refused. **A new port needs a redeploy:** ask the
operator to add it to `rovaraPrivateAddressPorts` and redeploy the install, then list the entry.

**One company per Enterprise install.** The routed ranges belong to the install, not to a company.
An Enterprise install serves one company, so its ranges are that company's. An install that served
several companies would need per-company ranges before this setting could be offered on it.

## The setting

Company settings, **Internal addresses** (`/v1/app/org/private-addresses`), lists the exact
addresses your tasks may reach:

- Each entry is one host and one port: `nexus.corp.example:8081` or `10.20.0.15:443`.
- No wildcards, no address ranges (CIDR), no port ranges and no entry without a port.
- IPv4 only, written as four plain numbers. Decimal, octal, hex and short forms are refused.
  IPv6 is refused, because task networks carry IPv4 only.
- A name must be a full name with at least one dot, without a trailing dot.
- At most 16 entries.

Some entries can never be listed: the cloud metadata service (169.254.169.254, fd00:ec2::254 and
the other link-local services), loopback, link-local addresses, public addresses (they need no
entry), the ranges the worker's own containers use (172.17.0.0 to 172.30.255.255 and
192.168.0.0/16), the network Rovara itself runs in (its VPC: the model proxy's load balancer, its
database, the VPC resolver and the broker all live there), the names of Rovara's own services, and
the ranges the install gives to private MCP servers and custom model endpoints. An address outside
the routed ranges is refused too.

A name that isn't on the install's allowed websites is accepted with a warning: tasks may not be able
to look it up through the install's DNS firewall. Add the name to a project's Allowed websites, or
list the server by its IP address.

Only company owners and admins see the list.

## Two people, and the audit ledger

- **Adding** anything is a proposal. A **different** owner or admin approves it from a live browser
  session, signed in within the last 10 minutes. The person who proposed it can't approve it, and a
  company with one admin can't add entries alone (there is no sole-owner exception).
- **Removing** entries applies at once, by one owner or admin.
- A proposal waits 7 days. Its proposer can withdraw it, and any other admin can turn it down.
  Proposal records are removed 30 days after they expire.
- Every change is in the audit ledger (`company.private_addresses_proposed`, `_changed`,
  `_withdrawn`). The record's facts hold only counts, the revision and a digest of the list; the
  hosts and ports are in the event's sealed company details.

## How the wall applies it

- A company's list applies to that company's tasks only. A worker belongs to one workspace, and a
  workspace to one company; the worker is launched with that company's approved list and no other.
- **Adding** applies to workers that start after the approval.
- **Removing closes access at once** (owner decision 128). Within a minute, every running worker of
  the company that started before the removal is recycled: an idle worker is stopped, and a busy one
  is stopped under its task, which is interrupted and fails at once with the usual "compute was
  lost; retry" error, so its retry starts within the minute. The next worker starts with the new
  list.
- Each time the worker container starts (a boot, a worker restart, a Docker restart), Rovara resolves
  each name once and checks every address it gets: each must be a private IPv4 address outside the
  never-listed ranges above (the install's own network is read from the worker's instance
  metadata). One bad address refuses the whole entry. The wall then opens exactly those address and
  port pairs (TCP) for task sandboxes, dev containers and setup runs, and nothing else.
- The addresses stay pinned until the next start of the worker container. If a name later answers
  with a different address (DNS rebinding, or a server that moved), nothing new is reachable. Task
  sandboxes and dev containers get the pinned name and address as a hosts entry, so their own
  lookups agree with the wall. Listing a server by IP address avoids the lookup altogether.
- The worker logs how many entries it opened and skipped at each start
  (`private-addresses.boot_facts`).
- A stored list that can't be read stops that company's workers from starting, with an error that
  says so, until an admin saves the list again. Other companies are not affected.
- The legacy single-file worker deployment doesn't apply the list.

## Operator controls

- **Kill switch.** Create the SSM parameter `<worker settings prefix>private-addresses-off` with
  the value `true`: every worker launch then carries no list, for every company. Delete it, or set
  it to `false`, to apply lists again. An unreadable or unexpected value counts as off. It takes
  effect at the next worker launch; use it with a worker recycle to close everything at once.
- **Ports.** `rovaraPrivateAddressPorts`, above. Changing it needs a redeploy.

## Release notes (0.5.15)

- **Task sandboxes, dev containers and setup runs can't reach private addresses any more.** On an
  Enterprise install that routes to your network, add an internal server's exact host and port under
  Company settings, Internal addresses, and have a second admin approve it. A server on a port other
  than 443 also needs the port in `rovaraPrivateAddressPorts`. Without that, installs from the
  internal server fail.
- **Dockerfiles that need BuildKit fail on walled workers.** Dev container builds use Docker's
  classic builder, because only it can keep build steps on the walled task network. BuildKit-only
  syntax, such as `RUN --mount=...` (cache, secret or bind mounts) and heredocs in `RUN`, fails to
  build. Rewrite those steps without BuildKit features, or build the image elsewhere and use it by
  name.
