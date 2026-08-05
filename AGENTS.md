# Principles

## Investigation and verification

- Clarify the user's intention before acting.
- Investigate comprehensively; require root cause instead of surface fixes.
- Propose verifiable actions, then execute them.
- When fixing bugs: identify the root cause, add unit tests, fix the bug, and
  rerun the tests.
- Do not cheat around constraints, tests, or review expectations.
- Do not short-circuit verification; evidence must support the claim.

## Long-term running

- For long-running or multi-step work, prepare durable execution up front.
- Propose `/goal` or `/loop` when those tools fit and are available.
- Prefer looped progress over one-shot guesses for open-ended tasks.
- For `third_party` submodules, default to two commits: commit inside the
  submodule first, then commit the parent repo submodule pointer update.

## Self-reflection and self-improving

- Reflect after each completed task on what worked and what did not.
- Propose concrete improvements to this file when lessons apply broadly.
- Apply those updates only with the user's confirmation.

## Writing style

- Prefer clear, concise writing.
- Prefer one-line sentences when possible.
- Wrap generated Markdown at 80 chars.
- Use repo-relative paths or plain code references.
- Do not add absolute filesystem paths.
- Do not hardcode environment-specific paths or similar host-layout
  assumptions into repo code.
- Do not write business data, or real repository identifiers into tests; use
  generic placeholders and synthetic fixtures instead.
- Add comments when they improve clarity.
- Do not report intermediate results or say "if you want" when the next step
  is clear; default to taking action directly.

## Polaris 0.3 Boundary

For the 0.3 release, Polaris is the only control plane. Work only with the
Polaris, Wanghai, and documentation repositories. Canonical product,
operations, and release documentation lives in the Polaris documentation site.

- Own Authing identity, user mapping, tenant/vault ownership, role capability
  checks, gateway sessions, rate limits, logical quotas, lifecycle, durable
  jobs, audit persistence, ingress, and deployment policy here.
- Keep Wanghai behind Polaris `POST /api/g/:serverId/launch` and the private
  `/g/` gateway. Never return or publish a direct Wanghai port, NodePort, or
  browser URL.
- Treat `9090` as a private implementation port. Docker must bind it to
  loopback; Pod and KubeVirt must use private services.
- In integrated mode Wanghai uses the mounted vault root `/vault/project`.
  Do not inject a separate shared Wanghai workspace root or a per-user
  `.env` override.
- Do not pass standalone `SMTP_*`, `OUTREACH_*`, `WANGHAI_*`, or
  `PORTAL_PROFILE_AUTH` settings into an integrated Wanghai runtime. Polaris
  injects only the reviewed private-root, gateway, and local-safety values.
- Revalidate current Polaris line/role access before proxying. A gateway cookie
  is transport state, not an authorization cache.
- Use only `status.driver.selected` to advertise or proxy Wanghai. Never fall
  back to a retained Docker, Pod, or KubeVirt configuration.
- Keep live external actions and integrated backup/restore lifecycle in Polaris.
  Wanghai must fail closed until Polaris has durable idempotency, outbox, and
  audit support.
- The only integrated backup path is the Polaris-owned `wanghai-backup` Docker
  job. It uses a digest-pinned, network-disabled one-shot image, the selected
  vault data attachment read-only, a separate per-vault backup volume, and a
  private key below `POLARIS_WANGHAI_BACKUP_KEY_ROOT`. Keep its named container
  until the durable result is persisted. Do not add a Wanghai portal backup,
  restore, or rollback route. The separate Polaris-owned restore staging slice
  accepts only a completed same-tenant/vault backup, uses a digest-pinned,
  network-disabled one-shot image with read-only `/backup` and a new private
  `/restore` volume, and persists only a verified staging result. Polaris also
  owns the separate activation and rollback jobs; keep the staging volume
  private and do not treat the isolated activation drill as production release
  proof.
- Keep manual intelligence-analysis completion in Polaris durable jobs. A
  Wanghai review export may be surface work, but direct analysis `prepare`,
  `run`, `finalize`, and `complete-review` must remain unavailable in
  integrated mode.
- Reject proxy request targets that can override the configured private origin.
  Strip browser credentials and upstream `Set-Cookie` values at the gateway.
- Keep standalone Wanghai support in a separate 0.3.1 batch. It requires an
  explicit external identity adapter and must not weaken integrated assertions.
- Use `config/release-profiles/0.3.0-single-host.json` as the 0.3 capacity,
  quota, resource-budget, and SLO source. Production preflight and the host
  launcher must validate it; do not raise its limits without new evidence.

Read the canonical Polaris Docs Design and Release TODO before
altering this boundary. Record each reviewed commit and its focused checks in
the maintained release documentation; do not add an internal release-directory
path to Polaris code or tooling.
