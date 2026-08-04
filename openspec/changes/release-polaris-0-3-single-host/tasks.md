## 1. Release Baseline And Scope

- [x] 1.1 Review the in-flight tenant-qualified migration and release-preflight
  slice, add any missing regression coverage, and commit it separately.
- [x] 1.2 Update canonical 0.3 documentation from a 50-100-user claim to the
  single-host 5-10 active-user release profile and staged 2/5/10 evidence.
- [x] 1.3 Add a machine-readable single-host release profile with maximum active
  vaults, worker concurrency, resource budgets, quota defaults, and SLO values.
- [x] 1.4 Add configuration validation that fails closed for invalid release
  profile values and prevents replica mode for the 0.3.0 profile.

## 2. Semantic Surface Mutations

- [x] 2.1 Inventory every integrated Wanghai mutation route and define an
  allowlisted Polaris action catalog with scope and version requirements.
- [ ] 2.2 Require and validate bounded idempotency keys and normalized request
  fingerprints for every admitted action.
- [ ] 2.3 Wire control-store idempotency records, workspace leases, and semantic
  audit records into the gateway mutation path.
- [ ] 2.4 Add signed write-admission claims and Wanghai verification for
  workspace, action, expected version, and quota reservation context.
- [ ] 2.5 Implement atomic Wanghai workspace mutation/version handling for the
  allowlisted actions without creating Wanghai-local policy.
- [ ] 2.6 Add gateway and Wanghai regressions for replay, conflicting key reuse,
  concurrent writers, stale versions, lock expiry, and cross-tenant writes.

## 3. Durable Integrated Jobs

- [ ] 3.1 Refactor the provision-only worker into a registered durable-job
  handler framework with bounded concurrency, lease heartbeats, retry classes,
  cancellation, and terminal audit.
- [ ] 3.2 Add authenticated Polaris job submission and status APIs for supported
  integrated workflow, analysis-completion, and derived-work actions.
- [ ] 3.3 Implement controlled tenant/vault-scoped workflow and
  intelligence-analysis job handlers that preserve Wanghai direct-execution
  rejection.
- [ ] 3.4 Implement bounded derived thumbnail/document handlers with output,
  timeout, retry, and cancellation limits.
- [ ] 3.5 Implement the authorized outbound-action outbox path, idempotency,
  provider retry classification, and immutable audit before enabling live SMTP.
- [ ] 3.6 Add restart-recovery, duplicate submission, cancellation, provider
  failure, and tenant-scope integration tests.

## 4. Backup And Restore

- [ ] 4.1 Implement a Polaris-owned encrypted backup adapter for a
  tenant-qualified vault root with checksums, retention metadata, and audit.
- [ ] 4.2 Implement restore to a new tenant-qualified root with archive,
  manifest, checksum, ownership, and path verification.
- [ ] 4.3 Implement explicit activation and rollback that preserve the original
  root and reject changed or cross-tenant targets.
- [ ] 4.4 Add synthetic backup/restore, corruption, retention, rollback, and
  cross-tenant isolation regression tests.
- [ ] 4.5 Run and record a remote backup/restore isolation drill before release.

## 5. Resource, Storage, And Observability

- [ ] 5.1 Implement Polaris logical quota accounting and reservation/reconciliation
  for workspace, cache, runtime, and identity categories.
- [ ] 5.2 Integrate quota reservations with admitted writes, uploads, jobs, and
  backup staging so exhaustion has no partial result.
- [ ] 5.3 Provision or validate a hard per-vault Docker storage ceiling on the
  release host and document the equivalent Pod/KubeVirt enforcement boundary.
- [ ] 5.4 Add single-host resource admission, active-vault limits, and bounded
  worker configuration for CPU, memory, PID, and ephemeral-storage budgets.
- [ ] 5.5 Emit tenant-safe metrics and structured events for gateway decisions,
  queue depth, job age/retries, quota, resource pressure, backups, and recovery.
- [ ] 5.6 Add alert thresholds, operator runbooks, and synthetic quota/resource
  pressure tests.

## 6. Immutable Promotion And Deployment

- [ ] 6.1 Complete and commit the digest-pinned image, private-port, wildcard
  DNS/TLS, and environment preflight integration.
- [ ] 6.2 Build the Polaris workspace base and Wanghai image from exact digests
  and generate SBOM, provenance, and signature verification artifacts.
- [ ] 6.3 Implement a release candidate manifest, one-deployment lock, smoke
  gate, verified previous-manifest rollback, and release metadata recording.
- [ ] 6.4 Add CI checks for formatting, type checking, unit/integration tests,
  dependency triage, image scanning, and promotion policy.
- [ ] 6.5 Configure external Authing, wildcard DNS/TLS, private Docker routing,
  registry access, signing, and backup storage on the release host.
- [ ] 6.6 Deploy the candidate to the designated remote host without disabling
  production authentication and record redacted configuration evidence.

## 7. Release Evidence And Decision

- [ ] 7.1 Run external ingress, direct-port, ticket replay, assertion, CSRF, and
  two-synthetic-tenant isolation tests against the deployed candidate.
- [ ] 7.2 Run restart, network-loss, slow-provider, queue-saturation,
  image-rollout, and resource/egress failure tests.
- [ ] 7.3 Run the 2-, 5-, and 10-user synthetic corpus and load stages, record
  SLOs, capacity reservation, alerts, and storage measurements.
- [ ] 7.4 Resolve or document dependency and security-audit findings with an
  owner and promotion decision.
- [ ] 7.5 Update canonical release evidence and runbooks, review every no-go
  gate, tag Polaris 0.3.0 only after all evidence is complete, and retain the
  prior verified release for rollback.
