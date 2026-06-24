---
name: use-polaris
description: Use when the user wants to create, render, start, inspect, or
  debug a Polaris workspace, especially for backend targeting, image
  preparation, status, or logs.
---

# Use Polaris

Use this skill when the task is operating Polaris itself.

Prefer the Docker backend unless the user asks for `pod` or `kubevirt-vm`.

## Phases

The Polaris CLI entrypoint is:

```bash
pnpm --dir apps/polaris run polaris --
```

### Phase 1: Create User

1. Run `create <project>`.
2. If the referenced user profile does not exist yet, let Polaris create it
   first.
3. Expect Polaris to create the user profile and the default credential
   registry together.
4. Confirm the saved spec points at the intended `user_profile`.
5. Confirm the saved spec also contains the default credential bindings.

### Phase 2: Prepare Specs And Images

For every backend:

1. Ensure the saved spec exists for the exact backend you will operate.
2. Build or refresh the required image set first.
3. For KubeVirt image preparation, use
   `scripts/operations/build-kubevirt-images.sh <rootdisk-ref>` as the
   authoritative build entrypoint.
4. Generate or refresh the backend manifest after image preparation.
5. Treat the saved spec and generated output as prerequisites, not optional
   follow-up steps.

For `docker` and `pod`:

1. Ensure the workspace `base_image` exists and is the image you intend to
   run.
2. Build or refresh the Docker workspace image before `start`.
3. Generate or refresh the backend manifest after the image is ready.

For `kubevirt-vm`:

1. Ensure the workspace `base_image` exists.
2. Build or refresh the Docker workspace image first.
3. Build or refresh the guest `rootdisk_image`.
4. Update the saved spec so `rootdisk_image` points at the new tag.
5. Generate or refresh the backend manifest after both images are ready.

### Phase 3: Start

For `docker` and `pod`:

1. Run `render <project>@<backend>`.
2. Run `start <project>@<backend>`.
3. Run `status <project>@<backend>`.
4. Run `logs <project>@<backend>` when needed.

For `kubevirt-vm`:

1. Run `render <project>@kubevirt-vm`.
2. Run `apply <project>@kubevirt-vm`.
3. Run `start <project>@kubevirt-vm` or `restart <project>@kubevirt-vm`.
4. Run `status <project>@kubevirt-vm`.
5. Run `logs <project>@kubevirt-vm` when needed.

The required order is:

1. Create user
2. Prepare specs and required image(s)
3. Start

For KubeVirt image work:

- Build the workspace OCI image first.
- Use `scripts/operations/build-kubevirt-images.sh <rootdisk-ref>`.
- The rootdisk build is guest-state aware and is the authoritative way to
  refresh the KubeVirt guest image and its workspace image lineage.
- KubeVirt requires two images in practice:
  - `base_image`
  - `rootdisk_image`

If the same project exists in multiple backends, always target
`<project>@<backend>`.

## References

Read `docs/polaris/README.md` when you need:

- the full command model
- runtime assembly details
- image preparation behavior
- backend-specific operator guidance

Read `docs/README.md` for the documentation entrypoint.
