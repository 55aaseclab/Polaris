# Polaris 0.3 Release

Status: **archived foundation record**. The active release is
[Polaris 0.3.4](../polaris-0.3.4/); this page preserves the original 0.3 gate
and evidence history.

> **Decision: GO for the designated HTTP test host; formal production
> promotion is deferred to 0.3.2.**

The archived foundation candidate was Polaris 0.3.1 on a controlled beta
profile. The active candidate is Polaris 0.3.4 on the reviewed single-host
profile; its current state and deployment evidence are recorded on the
[0.3.4 page](../polaris-0.3.4/). The designated test origin is
`http://m00e04c1b76c0.dyn.epfl.ch/`. The formal
`polaris.jianxiaoyitech.com` origin is a separate promotion gate and is not
used by this test candidate.

The archived 0.3.1 test-host release record is
[0.3-20260806-polaris-0.3.1-release.json](/release-evidence/0.3-20260806-polaris-0.3.1-release.json).
The current private surface maintenance record is
[the HTTP idempotency hotfix record](/release-evidence/0.3-20260805-private-surface-http-idempotency.json).

## 0.3 Scope

Enabled in this profile:

- Authing-backed session flow at the test origin.
- Polaris-gated private surface launch, navigation, workspace/file reads, basic
  mutations, and bounded uploads.
- Polaris-owned encrypted backup, restore staging, activation, and rollback.
- One host, one control plane, one bounded worker, and loopback-only private surface
  Docker ports.

Explicitly outside this launch profile:

- Public private surface ports or a private surface subdomain.
- Independent private surface identity, quota, rate-limit, lifecycle, or release
  authority in integrated mode.
- HA, gateway replicas, unsupported runtime promotion, or larger capacity
  claims.
- Workflow execution, analysis completion, and live SMTP/outreach without a
  Polaris-owned durable action contract.

## 0.3.0 Gates

1. One HTTP test origin and no public private surface endpoint.
2. Bounded tenant isolation, admission, backup/restore, and recovery evidence.
3. Direct test-host private surface build from a digest-pinned Polaris base, local
   manifest, smoke gate, and rollback.
4. Docker resource envelope, health/readiness, restart recovery, and operator
   runbook.

## Post-0.3 Roadmap

- **0.3.1:** released measured gateway and Portal host-list optimization with
  regression guards inside the existing release envelope. See the
  [0.3.1 performance record](../polaris-0.3.1/).
- **0.3.2:** signed image promotion, SBOM, provenance, Cosign verification,
  formal DNS/HTTPS/TLS, external release evidence, and production approval.
  See the [0.3.2 plan](../polaris-0.3.2/).
- **0.3.3:** user-count growth, storage budgets, logical quotas, resource
  enforcement, observability, and staged capacity evidence. See the
  [0.3.3 capacity plan](../polaris-0.3.3/).

Do not treat a passing test-host release as formal production approval.

## Read Order

1. [Design](./0.3-design.md): ownership and supported topology.
2. [Release TODO](./0.3-release-todo.md): the only 0.3 P0 checklist.
3. [Evidence](./0.3-release-evidence.md): verified results and open gates.
4. [Operator runbook](./0.3-operator-runbook.md): host operations and
   rollback.

## Update Rule

Check a box only after the named implementation, focused test, and environment
evidence exist. Keep this directory limited to the 0.3 release decision.
