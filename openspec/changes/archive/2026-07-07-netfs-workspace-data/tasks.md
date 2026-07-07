## 1. Config Model

- [x] 1.1 Extend the workspace attachment types and loaders to accept a
  first-class `netfs` source kind for `workspace-data`
- [x] 1.2 Update workspace validation to require the shared-source fields
  needed to realize `workspace-data` across supported backends
- [x] 1.3 Update provisioning and generated workspace specs so new workspaces
  emit `workspace-data` as a netfs-backed attachment and keep the three small
  durable attachments on their current source model

## 2. Backend Realization

- [x] 2.1 Update the Docker renderer to realize `workspace-data` from the saved
  netfs source instead of a backend-local project volume
- [x] 2.2 Update the pod renderer to realize the same `workspace-data` netfs
  contract without changing the existing semantics of the smaller attachments
- [x] 2.3 Update the KubeVirt path to realize or validate the same shared
  `workspace-data` contract used by Docker and pod

## 3. Lifecycle And Migration

- [x] 3.1 Keep backend switching limited to
  `workspace-runtime-state`, `user-identity-state`, and `user-ssh-state`
- [x] 3.2 Add switch-time validation so the destination backend fails early if
  the declared shared `workspace-data` source cannot be attached
- [x] 3.3 Add or update migration tooling for existing saved workspace specs so
  active user projects can adopt the netfs source shape safely

## 4. Verification

- [x] 4.1 Add config-loader and validation tests for the `netfs`
  `workspace-data` source
- [x] 4.2 Add backend-render tests that confirm Docker, pod, and KubeVirt all
  consume the same saved shared-source contract
- [x] 4.3 Add lifecycle tests that confirm backend switching does not copy
  `workspace-data` and still migrates the three smaller durable attachments
