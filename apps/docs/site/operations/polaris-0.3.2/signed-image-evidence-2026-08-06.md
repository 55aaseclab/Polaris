# Polaris 0.3.2 Signed Image Evidence

Date: 2026-08-06 UTC

Status: **supply-chain sub-gate complete**. This record does not close formal
DNS/TLS, clean-host production promotion, or external tenant evidence.

## Published Artifacts

| Artifact | Immutable reference | Source/workflow |
| --- | --- | --- |
| Polaris workspace base | `ghcr.io/jianxiaoyitech/polaris-workspace-base@sha256:dafa22943cdb75e41662f46130910b2c4602c568b2159f2c4483450040748eb7` | Polaris commit `3d96c8e`; workflow `31096714911` |
| private surface image | `ghcr.io/jianxiaoyitech/private-surface@sha256:b1a31a8576a101a922e31d9d0634a60087f4d7e5ee349af0b0c28079a6030f72` | private surface commit `a63ed8b`; workflow `31101132842` |

The private surface image was published under `master` and `sha-a63ed8b`. The
linux/amd64 platform manifest is
`sha256:39d52fe68fc9963028474b66396e9975e81f05b1d55243c30a45c765efdd1f59`;
the index digest above is the deployment reference.

This supersedes the earlier signed `d0828db7...` image so the immutable
deployment reference includes the removal of private surface's migrated local SEO
reference assets.

## Checks

- [x] private surface workflow tests and type checks passed before image publication.
- [x] The runner resolved the private Polaris base through the GHCR package
  Actions read grant and `docker buildx imagetools inspect`.
- [x] Release build rejected mutable or malformed base references.
- [x] The image build completed after reclaiming BuildKit cache before the
  registry scan.
- [x] Syft `v1.50.0` generated a 37,176,119-byte SPDX document without a disk
  exhaustion error.
- [x] The workflow published SLSA provenance, SPDX, and a keyless image
  signature, then verified all three.
- [x] An external Cosign `v3.1.3` verification on the immutable index passed
  for the image signature, SLSA provenance, and SPDX attestation.

The verified certificate identity matched:

```text
^https://github.com/jianxiaoyitech/private-surface/.github/workflows/build-admin-portal-image.yml@
```

with OIDC issuer:

```text
https://token.actions.githubusercontent.com
```

The SPDX attestation uses the pinned large-predicate Sigstore configuration
with Rekor disabled only for that attestation. The image signature and SLSA
provenance remain transparency-log backed.

## Size Note

The new private surface index has approximately 2.775 GiB of compressed image layers,
down from approximately 3.098 GiB for the failed pre-optimization candidate.
The container now uses Debian Chromium for the Playwright fallback and removes
duplicate browser/package-manager caches while retaining Camoufox.

## Remaining Gates

- [ ] Verify the exact image and attestations on the designated clean host
  under the production preflight configuration.
- [ ] Complete formal `polaris.jianxiaoyitech.com` certificate, cookie, CSP,
  and rollback evidence. Partial online perimeter checks are recorded in
  [formal-origin evidence](./formal-origin-online-2026-08-09.md).
- [ ] Complete the authenticated external tenant matrix and production
  approval.
