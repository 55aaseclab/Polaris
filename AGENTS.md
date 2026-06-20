# AGENTS.md

Use this flow:

```text
scripts/agentctl.ts -> config/specs/<backend-or-layer>/... -> config/generated/<backend>/<project>.yaml -> apply/spec handoff
```

- `scripts/agentctl.ts` is the unified entrypoint and source of truth.
- `config/specs/**` holds saved workspace intent and backend/profile-specific config.
- `config/generated/<backend>/<project>.yaml` is generated output.

Rules:

- Change `scripts/agentctl.ts` and `scripts/agentctl/**` first.
- Reapply with `pnpm exec tsx scripts/agentctl.ts <project>`.
- Do not hand-edit live Kubernetes resources as the final fix.
- Do not treat generated manifests as hand-maintained files.
- When persisted state causes restart issues, clean only stale runtime artifacts, not durable state.

Backend model:

- `backend.kind=pod` means the TypeScript control plane owns the live Deployment/Service path.
- `backend.kind=kubevirt-vm` means the TypeScript control plane owns the saved config and spec references, but live apply is not through the pod renderer.
- Backend-specific rules must live in backend-specific spec files, not in global operator notes.

Current migration layout:

- legacy pod specs still live in `config/gvisor/specs/<project>.agent.yaml`
- legacy kubevirt specs still live in `config/kubevirt/specs/<project>.agent.yaml`
- new long-term target layout is `config/specs/**` and `config/generated/**`

Daemon troubleshooting:

- If a Paseo daemon is reported as unavailable, first treat it as a runtime-health problem, not a pairing-link problem.
- A heavily loaded pod can make `kubectl exec`, readiness probes, daemon IPC, and pairing requests time out even when the pod still shows `Running`.
- Missing or broken daemon dependencies can make the daemon start path incomplete. In this repo, `pnpm` path/link issues are a known example.
- Multiple stale or terminating pods can leave behind orphaned gVisor `runsc-sandbox` processes. Those stale sandboxes can burn CPU on the host and make the current pod's daemon appear unavailable.
- `k3s` can lose track of old pods while their gVisor sandboxes are still alive on the host. In that state, Kubernetes may show only the current pod, but orphaned runtime processes from lost pods can still break exec, teardown, and daemon availability.
- When debugging daemon availability for `backend.kind=pod`, check all three layers:
  - pod liveness and readiness
  - daemon dependencies inside the pod
  - stale pods or orphaned runtime processes on the host

Validate with:

```bash
pnpm install
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsx scripts/agentctl.ts <project>
```
