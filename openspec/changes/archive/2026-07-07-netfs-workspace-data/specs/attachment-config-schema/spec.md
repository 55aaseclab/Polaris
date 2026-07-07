## ADDED Requirements

### Requirement: Attachment config SHALL expose a netfs source kind for shared
workspace data

The saved attachment config model SHALL support a first-class `netfs` source
kind for durable attachments that are backed by shared network storage. The
source model SHALL preserve backend-neutral location metadata and any
mount-specific options required to realize the same shared store across backend
drivers.

#### Scenario: Saved workspace declares netfs-backed workspace data

- **WHEN** a saved workspace spec declares `workspace-data`
- **THEN** its attachment source SHALL be allowed to use `kind=netfs`

#### Scenario: Netfs config remains authoritative across backends

- **WHEN** a workspace spec declares a `netfs` source for `workspace-data`
- **THEN** Docker, pod, and VM render paths SHALL consume that saved source as
  the authoritative project-data contract
