# Polaris 0.3.4

Status: **archived as source tag `0.3.4` on 2026-09-11**. Polaris 0.3.3 is
archived; its capacity, migration, and deployment records remain the
historical baseline. The current shipped source baseline is
[Polaris 0.4.0](../polaris-0.4.0/).

References below to private surface are retained only as historical deployment
evidence. private surface documentation and source are archived; current product
ownership and active documentation are in Polaris.

## Release Identity

| Field | Current decision |
| --- | --- |
| Release identity | `POLARIS_RELEASE_ID=0.3.4` |
| Capacity profile | `0.3.0-single-host` |
| Supported ceiling | 20 concurrently active vaults |
| Topology | One Polaris control plane, gateway, and durable worker |
| Compatibility | None for retired storage or runtime roots |
| Previous release | [Polaris 0.3.3 (archived)](../polaris-0.3.3/) |

The profile id remains separate from the release id. The 20-vault limit,
resource envelope, quota, worker concurrency, and recovery SLO are inherited
from the measured 0.3.3 baseline; 0.3.4 does not raise them.

## State Of The Art

- **Control plane.** Polaris owns Authing identity mapping, user, tenant, and
  vault ownership; role capabilities; gateway sessions; rate limits; logical
  quotas; lifecycle; durable jobs; audit; ingress; and deployment policy.
- **Vault data.** Control data and vault business data use separate canonical
  roots. The completed migration is explicit and the old layout is archived,
  not read as a fallback.
- **Retained compatibility runtime.** The former private surface source repository is
  archived. Any retained vertical runtime remains private and Polaris-
  controlled; current browser traffic and active product ownership remain with
  Polaris.
- **Recovery.** Polaris owns encrypted backup, restore staging, activation,
  rollback, retention, and key derivation below the Polaris data root.
- **Portal.** The browser Portal is an independent React app at
  `apps/polaris-portal`, with live host projections and the user page's
  session section separated from profile and credentials.
- **Paseo.** The Polaris-owned integration, patches, artifacts, and tool
  bundle live under `packages/paseo`. Paseo remains the coding surface and is
  not yet replaced.
- **Deployment.** The m00 test host is the only designated remote verification
  host. Blue/green deployment, health/readiness probes, and unauthenticated
  gateway denial remain the operational path.

The current source baseline includes the control/vault-data split, data-root
backup-key derivation, Portal extraction, Paseo package relocation, the
Paseo-aligned Portal visual system, Docker vertical-runtime startup fixes,
the Wanghai migration boundary, and the durable mock workflow control slice.
The last recorded m00 candidate is
`c13647b1fbc0a2b8fe140efd3564e9c78fece846`. The source tag `0.3.4` is the
current working-tree baseline after that candidate. Formal production
promotion remains separate.

## Focused Verification Already Available

These checks describe the working source and the focused checks run before the
m00 cutover. They are separate from the deployed evidence below.

| Check | Result |
| --- | --- |
| Portal typecheck, tests, and production build | Passed; Portal tests `5/5` |
| `pnpm run test:surfaces` | Passed; surface tests `41/41` |
| `pnpm run build:surfaces` | Passed |
| `pnpm --filter polaris run check` | Passed |
| `pnpm --filter polaris run test` | Passed; smoke tests `24/24` |
| `scripts/ci-local.sh` | Passed; `257/257` default Polaris regression tests |

## m00 Candidate Deployment

Date: 2026-08-11 UTC

Status: **deployed to the designated HTTP test host** through the existing
blue/green path. This is local-test deployment evidence, not production
approval. The candidate manifest was generated on m00 from the reviewed host
environment and binds the active source commit, the fixed `0.3.0-single-host`
profile, both image digests, and the current migration evidence.

| Field | Result |
| --- | --- |
| Candidate source | `c13647b1fbc0a2b8fe140efd3564e9c78fece846` |
| Release/profile | `0.3.4` / `0.3.0-single-host` |
| Migration label | `release-0.3.4-vertical-paseo-shell-syntax` |
| Manifest SHA-256 | `1a22ca7d3601f1c4e56957f4849521367c8babe5bf74cebba50a5cb2e9a33a4b` |
| Previous manifest | `dfb310cb323e21efb28851b33dd6617c99b24da20419358f640f806b61d0e2cd` |
| Active color | `blue` |
| Host environment SHA-256 | `9940bbe4d5a47ca751389ce96cc16f873ba7ec575cb4c59ae9cd5dd52e245bd7` |
| Host release environment | Release ID `0.3.4`; max active vaults `20` |

Manifest SHA-256:
`1a22ca7d3601f1c4e56957f4849521367c8babe5bf74cebba50a5cb2e9a33a4b`

The [redacted deployment record](/release-evidence/0.3-20260811-polaris-0.3.4-vertical-startup.json)
contains the machine-readable checks.

## Deployed Verification

| Check | Result |
| --- | --- |
| `/healthz` and `/readyz` | `200` / `200` |
| Portal `/welcome`, `/hosts`, `/settings/user` | `200` |
| Portal `/shell/shell.js` and `/shell/shell.css` | `200`; light tokens served and dark markers absent |
| Paseo `/paseo/` and `manifest.json` | `200` after the `/paseo` redirect |
| Paseo web JS and CSS assets | `200` |
| Private gateway `/g/` without a session | `401` |
| Retired direct `/private-surface/` route | `404` |
| Vertical `test-vertical` startup | private surface health/readiness `200/200`; Paseo listener and persisted pairing/server-id present; fixture removed after verification |
| Public private surface ports `9090`, `32001`, `32002` | External connections failed; no host listener or candidate mapping was present |

The active blue candidate has no public private surface gateway port. The remote
check found no active private surface container or `9090` listener, and the private
gateway boundary still returned `401` without a session.

## After This Ship

1. Repeat host-bound manifest generation and read-only remote checks only
   when a new designated-host candidate is cut from this tag.
2. Close or explicitly carry forward the remaining external authenticated
   tenant matrix, failed-restart committed-write proof, signed supply-chain
   evidence, and operator approval gaps.
3. Keep the 0.3.3 capacity and migration evidence immutable. New workflow
   and live-tool work belongs on [Polaris 0.4.0](../polaris-0.4.0/).

## Relationship To Later Releases

- [Polaris 0.4.0](../polaris-0.4.0/) is the active workflow implementation
  slice built on this 0.3.4 boundary. Its Phase 3-6 control state is
  mock-only and does not reopen the archived vertical runtime.
- [Polaris 0.5.0](../polaris-0.5.0/) remains a planned local-cell and cohort
  lifecycle release. It continues to consume the 0.3.3 capacity baseline and
  is not re-scoped by this version bump.

## Evidence Rule

Implementation, isolated staging, and deployed evidence remain separate. A
source test or successful build does not close a release gate; each 0.3.4
claim must name its commit, focused check, environment, and redacted result.
