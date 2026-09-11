# Polaris 0.3 Agent Handoff

## Mission

Maintain the shipped Polaris 0.3.4 source baseline on the inherited
single-host 20-vault profile without a tenant-boundary failure,
unauthenticated access to the retained private surface, data loss, or an
unrepeatable release. Polaris 0.3.3 is archived. The source tag is `0.3.4`.
Formal production promotion remains separate. New workflow and live-tool work
belongs on the 0.4.0 page.

## Restore Context

Read these in order before changing release-related code or documentation:

1. `site/operations/polaris-release/index.md`
2. `site/operations/polaris-release/0.3-design.md`
3. `site/operations/polaris-release/0.3-release-todo.md`
4. `site/operations/polaris-release/0.3-release-evidence.md`
5. `site/operations/polaris-0.3.4/index.md`
6. `../polaris/AGENTS.md` for Polaris work

The TODO is the only release checklist. The evidence page is the only release
result register. Do not recreate a chronological release plan or a second
surface-boundary document.

## Current State

The Polaris runtime boundary, backup recovery, resource envelope, restart
drill, 20-vault capacity baseline, control/vault-data migration, and
Portal/Paseo surface extraction have source or isolated-host evidence. The
0.3.3 capacity and migration records are archived; 0.3.4 inherits the same
20-vault profile and is the shipped source baseline.

Open 0.3.4 carry-forward work is the external authenticated tenant matrix,
failed-restart committed-write proof, signed promotion evidence, security
triage, and operator approval. Standalone runtime variants, unsupported
runtimes, larger capacity, and live workflow tools remain outside this line.

## Non-Negotiable Boundary

- Polaris is the only integrated control plane for identity, tenant/vault
  ownership, roles, rate limits, quotas, lifecycle, jobs, audit, ingress, and
  deployment.
- A retained vertical runtime is vault-scoped and may verify Polaris assertions
  and enforce local UI/API/path/request safety, but it does not own identity,
  roles, rate limits, quotas, lifecycle, or release policy.
- Rate limits and product quotas stay in Polaris. A runtime may keep local
  bounds only to protect one request or process.
- Integrated runtimes use the fixed direct mounts `/vault/workspaces`,
  `/vault/backups`, and `/vault/cache`; they do not receive a shared workspace
  root or a caller-selected host path.
- No public runtime implementation port or Kubernetes NodePort is exposed.
  Browser traffic goes through Polaris only.
- Direct integrated workflow execution, analysis completion, and live
  SMTP/outreach stay blocked until Polaris owns their durable job or outbox
  paths. Backup/restore is the P0 exception and remains Polaris-owned.

## Scope And Deployment Safety

- Work only in `../polaris` and this documentation repository. Ignore other
  sibling repositories.
- Use only `root@m00e04c1b76c0.dyn.epfl.ch` for deployment and service tests.
  Never start Polaris services on the local workstation or another host.
- Use synthetic tenants for candidate checks, bind Polaris and the retained
  private surface to loopback, and remove temporary candidates after evidence
  collection. Ensure any public `9090` binding is down after testing. Do not
  alter tenant data.
- Authing may be disabled only in an isolated loopback synthetic fixture and
  must be restored before the candidate is removed.
- Do not use or record real credentials, customer data, cookies, assertions, or
  unredacted host output.
- Preserve user work, including Polaris untracked `packages/paseo/.surface-*`
  directories. Deployment topology lives in Vault Management, not a separate
  operations page.

## Working Method

1. Select one TODO item and state the expected security, migration, and
   rollback impact.
2. Keep the change in the proper owner: Polaris for active control-plane and
   retained-surface policy, and this repository for cross-repository design,
   operations, and evidence.
3. Add focused regression coverage, inspect affected renderer or generated
   deployment output, and run the smallest relevant check before broader tests.
4. Review the staged diff with `git diff --check`; commit only the reviewed
   small batch and leave unrelated user changes untouched.
5. Record a concise evidence row only after an isolated or production test. A
   unit test or source commit alone cannot close a release gate.
6. Check a TODO item only when its listed completion condition and evidence
   both exist. Keep all other boxes open.

## Documentation Rules

- Keep the original release directory to the 0.3 index, design, TODO,
  evidence, and operator runbook. Treat `site/operations/polaris-0.3.3/` as
  archived historical evidence and `site/operations/polaris-0.3.4/` as the
  active working release summary; neither replaces the original gate record.
- State whether a result is implementation, isolated staging, or production.
- Keep larger-capacity and standalone work outside the `0.3.0` exit decision.
- Do not publish secrets, customer identifiers, IP addresses, internal paths,
  or full host logs.
