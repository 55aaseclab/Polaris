# AGENTS.md

Use this flow:

```text
scripts/agentctl.py -> agents/<project>.agent.yaml -> agents/<project>.yaml -> apply
```

- `scripts/agentctl.py` is the source of truth for pod behavior.
- `agents/<project>.agent.yaml` is the saved project config.
- `agents/<project>.yaml` is generated output.

Rules:

- Change `scripts/agentctl.py` first.
- Reapply with `python3 scripts/agentctl.py <project>`.
- Do not hand-edit live Kubernetes resources as the final fix.
- Do not treat `agents/*.yaml` as hand-maintained files.
- When persisted state causes restart issues, clean only stale runtime artifacts, not durable state.
- For the Morpheus KubeVirt VM, keep Paseo durable state at `PASEO_HOME=/root/.paseo`,
  where `/root/.paseo` is a symlink to `/workspace/.paseo`. Do not move `PASEO_HOME`
  to a separate runtime directory or create a second Paseo state source, because that
  changes daemon identity and breaks existing pairing/connection state.

Validate with:

```bash
python3 -m unittest tests.test_agentctl_user_story
python3 scripts/agentctl.py <project>
```
