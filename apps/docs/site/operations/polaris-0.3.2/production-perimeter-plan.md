# Polaris 0.3.2 Production Perimeter Plan

Status: planned post-`0.3.1` production-readiness work. Performance is owned
by 0.3.1; user-count growth, capacity tuning, and storage minimization are
owned by 0.3.3.

## Objective

Convert the controlled HTTP test-host candidate into a formally verifiable
single-origin release without making private surface a second Polaris control plane.

## Workstreams

### 1. Supply Chain

- [x] Publish the digest-pinned Polaris workspace-base and private surface artifacts
  used by the current source-based single-host deployment. A separate Polaris
  application image is not part of that deployment.
- [x] Generate SPDX SBOMs and SLSA provenance for both published artifacts.
- [x] Sign the private surface image digest and its provenance/SBOM attestations with
  the approved GitHub Actions Cosign identity.
- [ ] Verify signatures, provenance, and SBOM policy on a clean host before
  deployment.
- [x] Prove traffic rollback to the previous color after a failed promotion
  path ([formal rollback drill](./formal-rollback-drill-2026-08-09.md)).
  Data-root bytes and user-dir count were unchanged; active color returned to
  the current `0.3.2` blue candidate.

The test-host local build remains valid as 0.3.0 evidence, but it is not a
substitute for this supply-chain gate.

#### Workspace Base Handoff

Polaris owns the workspace base image. Its GitHub Actions workflow is
`.github/workflows/build-workspace-base-image.yml` and builds
`config/docker/vault-prebuilt.Dockerfile` without importing generated local
tool-bundle state.

The package contract is:

```text
ghcr.io/jianxiaoyitech/polaris-workspace-base
```

private surface must consume only the digest form produced by the workflow:

```text
ghcr.io/jianxiaoyitech/polaris-workspace-base@sha256:<digest>
```

After the first successful Polaris workflow run:

- [x] In the GHCR package settings, add the `jianxiaoyitech/private-surface` repository
   under **Manage Actions access** with read access.
- [x] Set private surface's `POLARIS_WORKSPACE_BASE_IMAGE` repository variable to the full
   digest-pinned reference from the Polaris workflow summary.
- [x] Verify access from the private surface workflow with
   `docker buildx imagetools inspect` before publishing its image.

The workflow does not provide an unsigned or mutable bypass for release
builds. The signed digest and both attestations are recorded in the
[signed-image evidence](./signed-image-evidence-2026-08-06.md); clean-host
verification and production promotion remain open.

The full workspace-base SPDX document is larger than the public Rekor
transparency-log entry limit. The workflow therefore stores the complete SPDX
attestation in GHCR using a pinned Sigstore signing configuration with Rekor
disabled for that attestation only, and verifies its Fulcio identity and
signature with `--insecure-ignore-tlog`. The image signature and SLSA
provenance continue to use the public transparency log. This is a signed
registry attestation, not an unsigned SBOM or a skipped SBOM gate.

### 2. Formal Single Origin

- [x] Configure only `polaris.jianxiaoyitech.com` as the formal public origin.
- [x] Observe the current HTTPS certificate window and SAN set
  (valid through 2027-01-11; ~154 days remaining at the 2026-08-09 re-check).
  Dedicated-origin CN policy and automated expiry monitoring remain open.
- [x] Validate HTTP-to-HTTPS, unauthenticated API denial, Authing config
  redirect URI, and public port closure on the formal origin.
  Secure authenticated cookies and explicit CSP `frame-ancestors` remain open.
- [x] Confirm that no private surface subdomain or public `9090` route is required or
  reachable. Raw-upstream and authenticated gateway checks remain open.
- [x] Capture external DNS/TLS/unauthenticated ingress evidence
  ([formal TLS re-check](./formal-tls-and-perimeter-2026-08-09.md)).
  Formal-host rollback evidence remains open.

The checks completed so far are recorded in
[formal-origin online evidence](./formal-origin-online-2026-08-09.md). The
post-bump candidate observations are recorded in
[post-bump online evidence](./formal-origin-post-bump-online-2026-08-09.md).
compound certificate, cookie, CSP, Authing, and rollback items stay open until
an authenticated browser run and a rollback drill are recorded.

No additional product or private surface subdomain is part of this plan.

### 3. External Release Evidence

- [ ] Run the complete two-live-tenant matrix through the formal origin using
  real Authing-backed browser sessions and synthetic tenant data.
- [ ] Re-run launch, reads, mutations, upload limits, ticket replay, CSRF,
  tenant isolation, restart, backup/restore, and gateway rollback checks.
- [ ] Record the named operator, security reviewer, approver, source commits,
  image digests, manifest digest, and redacted evidence artifacts.
- [ ] Complete dependency/security triage and resolve or explicitly accept
  every release finding.
- [ ] Make the production go/no-go decision with a documented rollback owner.

The 0.3.1 performance report is a regression input only. This workstream is
about external trust and release proof; the separate 0.3.3 plan owns user-scale
capacity validation after this perimeter is available.

The local two-vault scoped coding regression is a required regression guard and
is recorded in [Infamous Regression](../infamous-regression.md). It does not
close the authenticated external tenant gate.

## Acceptance Gates

- [ ] Clean-host verification rejects unsigned, mutable, or unprovenanced
  images.
- [ ] The formal origin passes DNS, TLS, Authing, gateway, and rollback checks.
- [ ] Two synthetic live tenants remain isolated through the external matrix.
- [ ] Security triage and production approval are recorded.
- [x] No public private surface subdomain or raw `9090` route exists.

## Out Of Scope

- User-count growth, staged scale runs, storage budgets, and capacity
  boundaries; these belong to 0.3.3.
- High availability, gateway replicas, and unsupported runtime promotion
  unless a separate release decision adds them.

## Evidence Register

Keep signed artifact attestations, certificate/DNS checks, external smoke
results, security triage, approval, backup/restore reports, and rollback
records in a separate 0.3.2 evidence register. Do not rewrite the dated 0.3.0
evidence artifacts; annotate their deferred work with the current roadmap
version instead.
