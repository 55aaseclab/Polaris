# Infamous Regression: Scoped Coding Host

This page records the Polaris/Paseo regression that made two coding vaults
appear in one host list, connected only one of them, and redirected the second
route to settings.

## Symptom

The Portal route was `/v/<serverId>/coding`, which correctly opened Paseo at
`/h/<serverId>`. During Expo startup, the URL could keep the same `serverId`
while its `scope` query changed. The observed errors were:

```text
[polaris-host-sync] failed to upsert host test-coding
Error: Paseo host scope changed
[AgentPanel] history sync failed
Error: Daemon client closed
```

The visible result was `/settings/general`. That was wrong: the URL already
identified the host selected by the user.

## Reproduction

The reproduction was run on m00 with auth disabled and two temporary coding
vaults:

| Vault | Paseo server ID |
| --- | --- |
| `repro-coding-a-20260809` | `srv_DOqwdgEYDOCd` |
| `repro-coding-b-20260809` | `srv_5pE3JR0GQQ1P` |

For both vaults, `/v/<serverId>/coding` first entered the correct `/h/<serverId>`
route. The failure occurred during host registry synchronization, so Portal
mapping was not the failing boundary.

## Debugging Method

1. Preserve the complete browser URL: pathname, query, and fragment.
2. Decode route identity independently from query scope. The stable identity is
   the Paseo `serverId` in `/h/<serverId>`; `scope` is mutable startup metadata.
3. Reproduce with two vaults having different IDs and labels. One vault cannot
   expose first-item fallback or cross-host client reuse.
4. Trace each boundary separately: Portal `/v` mapping, Paseo `/h` parsing,
   sync deduplication, offer upsert, registry filtering, and navigation.
5. Record the `serverId` at every boundary and compare by ID, never by label,
   offer URL, query, or array position.
6. Verify the built artifact after deployment. Passing source tests alone does
   not prove that a patch-generated web bundle contains the fix.

The decisive evidence was: pathname `/h/<same serverId>` remained unchanged;
only `scope` changed. The old implementation treated that metadata change as
a route change, rejected the offer upsert, and fell through to settings.

## Root Cause

Host-sync identity incorrectly included mutable URL scope/offer state. This
invalidated an in-flight sync while the selected route was still valid. The
upsert then failed with `Paseo host scope changed`; startup interpreted the
settled, unmatched registry as an absent host and navigated to settings. The
`Daemon client closed` message was a consequence of losing the selected
host/controller, not evidence that the server disappeared.

## Correctness Contract

- `/v/<serverId>/coding` resolves to `/h/<serverId>`.
- Sync deduplication is keyed by `token + serverId`; scope and offer changes do
  not change route ownership.
- `/h/<serverId>` and `/paseo/h/<serverId>` parse to the same ID.
- A scoped route shows only its own host and never the first unrelated host.
- Sync for host A cannot reuse, close, or replace host B's client.
- A transient sync failure cannot become navigation to a different host or
  `/settings/general`.

## Required Regression

The regression must exercise the complete two-vault sequence:

1. Create two coding vault records with distinct `serverId` values.
2. Open both `/v/<serverId>/coding` URLs.
3. Rewrite `scope` during initialization while preserving `/h/<serverId>`.
4. Run host synchronization for both routes, including an offer-upsert error
   for the non-selected record.
5. Assert each route remains bound to its own ID, the scoped registry excludes
   the sibling, and the selected runtime client is not closed.
6. Assert the final route is `/h/<serverId>` or a legitimate child route, never
   `/settings/general`.

The focused Paseo suite is:

```bash
pnpm --dir packages/paseo/source/packages/app exec vitest run \
  src/lib/polaris-host-sync.test.ts \
  src/navigation/host-runtime-bootstrap.test.ts \
  src/runtime/host-runtime-auth.test.ts \
  src/runtime/host-runtime.test.ts \
  src/utils/host-routes.test.ts
```

The release gate remains:

```bash
bash ./scripts/ci-local.sh
bash ./scripts/cd-remote.sh root@polaris.jianxiaoyitech.com
```

## Deployment Evidence

The fixed source was committed as `123a073` and pushed to `origin/master`.
The blue/green rollout completed and switched the public service to `green`.

```text
bundle: index-6b2f155a59678d880a557c732c16c0ce.js
SHA256: 4f3652f2932ebc1928793cee1e8bde501297db425b044d40ab1c3bfa272d92dd
```

Remote checks showed `polaris-server@green.service` active, both green
containers running, and `https://polaris.jianxiaoyitech.com/paseo/` serving
Paseo. `/api/session` correctly required authentication in production.

## Why It Regressed

The earlier fix addressed the visible redirect but did not make the identity
contract executable across the whole startup sequence. The behavior is split
among Portal routing, Expo parsing, host sync, storage isolation, runtime
controllers, and patch-generated artifacts. Existing tests covered helpers but
not this transition as one sequence:

```text
/v/<serverId>/coding
  -> /h/<serverId>?scope=old
  -> /h/<same serverId>?scope=new
  -> sync settles
  -> runtime/navigation decision
```

That gap allowed a later patch or build change to reintroduce scope as an
identity signal without failing the normal suite. A green source test also did
not prove the correct patch hunk reached production.

## Prevention

- Keep the two-vault case as a named regression with a negative assertion
  against `/settings/general`.
- Test route identity, sync deduplication, registry filtering, controller
  lifetime, and navigation together.
- Require clean-base patch application and artifact verification in CI.
- After deployment, compare remote bundle name and SHA256 and inspect the
  active blue/green color.
- Log pathname, query, fragment, server ID, sync key, sync status, host list,
  and client lifecycle in one trace.
- Never use labels such as `test` or `test-coding` as identity.

**The URL `serverId` owns the current coding surface; everything else is
mutable metadata.**
