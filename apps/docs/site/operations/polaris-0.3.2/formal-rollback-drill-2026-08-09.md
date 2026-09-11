# Polaris 0.3.2 Formal-Host Rollback Drill

Date: 2026-08-09 UTC

Status: **passed traffic rollback round-trip on the formal origin host**. No
user data was modified or deleted. This closes the failed-promotion traffic
switch evidence for blue/green; it is not a full production go/no-go.

## Host And Safety

```text
host: root@polaris.jianxiaoyitech.com
public origin: https://polaris.jianxiaoyitech.com
method: scripts/rollback-remote.sh <color>
data root: /srv/polaris/data (never deleted or replaced)
```

| Fingerprint | Pre | After rollback to green | After restore to blue |
| --- | ---: | ---: | ---: |
| `du -sb /srv/polaris/data` | 60665657 | 60665657 | 60665657 |
| User profile directories | 69 | 69 | 69 |
| Active color | blue | green | blue |
| Serving release id | 0.3.2 | 0.3.1 | 0.3.2 |
| Upstream | 127.0.0.1:18080 | 127.0.0.1:28080 | 127.0.0.1:18080 |

No synthetic containers were created. Creator-destroys does not apply beyond
the rollback script’s upstream marker updates.

## Sequence

1. **Pre:** active `blue` / `POLARIS_RELEASE_ID=0.3.2`; inactive `green` /
   `0.3.1`. Both color stacks healthy on loopback.
2. **Rollback:** `bash scripts/rollback-remote.sh root@polaris.jianxiaoyitech.com green`
   — nginx upstream switched to `28080`.
3. **Mid checks:** public HTTPS `/healthz` `/readyz` `/paseo/` = 200;
   unauthenticated `/api/session` = 401.
4. **Restore:** rollback to `blue` — upstream `18080`, release `0.3.2`.
5. **Post checks:** same HTTPS probes; data fingerprints unchanged.

## External Probes (each phase)

| Check | Pre (0.3.2 blue) | Mid (0.3.1 green) | Post (0.3.2 blue) |
| --- | --- | --- | --- |
| HTTPS `/healthz` | 200 | 200 | 200 |
| HTTPS `/readyz` | 200 | 200 | 200 |
| HTTPS `/paseo/` | 200 | 200 | 200 |
| HTTPS `/api/session` | 401 | 401 | 401 |

## What This Proves

- Failed-promotion **traffic** can move to the previous color without touching
  the data root.
- The previous color (`green` / 0.3.1) was healthy enough to serve public
  health and unauthenticated denial.
- Returning to the current color (`blue` / 0.3.2) restores the candidate
  identity with identical data fingerprints.

## What This Does Not Prove

- Authenticated tenant continuity across the switch (no browser matrix).
- Automatic detection of a bad candidate and operator runbook paging.
- SBOM/Cosign clean-host gate or security go/no-go approval.
- Manifest file contents on disk are shared per app dir; color-specific
  **runtime** identity came from `polaris-server-{blue,green}.env` release ids.

## Rollback Owner (drill)

| Role | Record |
| --- | --- |
| Operator executing drill | automated release agent session on 2026-08-09 |
| Host | formal origin `polaris.jianxiaoyitech.com` |
| Command | `scripts/rollback-remote.sh root@polaris.jianxiaoyitech.com <blue\|green>` |

Production go/no-go still needs a named human approver.

## Artifacts

```text
site/public/release-evidence/0.3.2-20260809-formal-rollback/
```
