# Internal addresses tasks may reach

From 0.5.15, task sandboxes and dev containers run behind a wall: they reach the internet, but no
private address (10.x, 172.16-31.x, 192.168.x, 100.64-127.x), no link-local address and nothing on
the worker itself. That keeps a task away from Rovara's own services and from your network.

Many companies install packages from an internal server: a private npm, PyPI or Maven mirror, or
Artifactory or Nexus on a private address. Without an entry here, every task that installs from such
a server fails at install time.

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
entry), the ranges the worker's own containers use (172.17.0.0 to 172.31.255.255 and
192.168.0.0/16), the network Rovara itself runs in (its VPC: the model proxy's load balancer, its
database, the VPC resolver and the broker all live there), and the names of Rovara's own services.

Only company owners and admins see the list.

## Two people, and the audit ledger

- **Adding** anything is a proposal. A **different** owner or admin approves it from a live browser
  session, signed in within the last 10 minutes. The person who proposed it can't approve it, and a
  company with one admin can't add entries alone (there is no sole-owner exception).
- **Removing** entries applies at once, by one owner or admin.
- A proposal waits 7 days. Its proposer can withdraw it, and any other admin can turn it down.
- Every change is in the audit ledger (`company.private_addresses_proposed`, `_changed`,
  `_withdrawn`). The record's facts hold only counts, the revision and a digest of the list; the
  hosts and ports are in the event's sealed company details.

## How the wall applies it

- A company's list applies to that company's tasks only. A worker belongs to one workspace, and a
  workspace to one company; the worker is launched with that company's approved list and no other.
- The list reaches a worker when the worker starts. A change applies to workers started after it.
  A running worker keeps the list it started with until it stops (an idle stop, or the end of its
  session).
- At each worker start, Rovara resolves each name once and checks every address it gets: each must
  be a private IPv4 address outside the never-listed ranges above (the install's own network is read
  from the worker's instance metadata). One bad address refuses the whole entry. The wall then opens
  exactly those address and port pairs (TCP) for the task network, and nothing else.
- Names are pinned for the worker's session. If a name later answers with a different address (DNS
  rebinding, or a server that moved), nothing new is reachable; a server that moved is reachable
  again after the next worker start. Listing the server by IP address avoids the lookup altogether.
- A name entry also has to resolve from Rovara's network. Where the install restricts DNS (a hosted
  install's DNS firewall), add the name to the allowed websites too, or list the server by address.
- Setup runs (the project setup agent) don't get the list today; package installs during setup must
  use public mirrors.
- The legacy single-file worker deployment doesn't apply the list.

## Release notes (0.5.15)

- **Task sandboxes and dev containers can't reach private addresses any more.** If your projects
  install packages from an internal server, add its exact host and port under Company settings,
  Internal addresses, and have a second admin approve it. Without that, installs from the internal
  server fail.
- **Dockerfiles that need BuildKit fail on walled workers.** Dev container builds use Docker's
  classic builder, because only it can keep build steps on the walled task network. BuildKit-only
  syntax, such as `RUN --mount=...` (cache, secret or bind mounts) and heredocs in `RUN`, fails to
  build. Rewrite those steps without BuildKit features, or build the image elsewhere and use it by
  name.
