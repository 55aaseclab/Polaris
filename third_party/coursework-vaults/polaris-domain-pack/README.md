# Polaris Coursework Vaults Domain Pack

`main.ord` describes a course-work environment with two explicit roles:

- `teacher`: publishes an assignment, fixes one base image for the class,
  provisions one private Vault per roster member, freezes and snapshots the
  class, and reproduces a student's environment.
- `student`: enters only the current student's assignment Vault, saves
  checkpoints, submits a Vault snapshot before the deadline, and reads only
  that student's feedback.

The pack carries the shared `imageDigest` through the workflow so a host can
verify that every student Vault started from the same image. The role modules
are metadata for the Portal catalog; Polaris still derives the actor from the
authenticated session and enforces tenant, course, assignment, and Vault
scope at every port binding.

The DSL intentionally does not accept a student identity from the student
form. `ResolveCurrentStudent` and `ResolveCurrentTeacher` are host-bound
ports. Their bindings must fail closed when the session role is wrong. The
student Vault ports must resolve the current student's Vault and never accept
another student's Vault identifier as authority.

Install from the Polaris repository root:

```bash
pnpm --dir apps/polaris run polaris -- pack add \
  "$PWD/third_party/coursework-vaults/polaris-domain-pack"
```

The pack contains eight flows grouped into the two roles. The teacher
freeze/snapshot flow is the deadline boundary: after it succeeds, the host
must expose read-only student Vaults and durable snapshots. The teacher
reproduction flow must use the recorded snapshot and image digest, then
verify that the recreated environment matches both.
