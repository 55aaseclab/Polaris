# What Your Team Gets

### 1. Onboarding

When a new member joins, the first question is simple:
can they get into a usable environment quickly without hand-built setup?

What teams usually want at this stage:

- a standard environment with a predictable default toolchain and no manual
  setup
- one path to create and start a workspace

What your team gets today:

- one shared Docker foundation for standard workspaces
- one workspace-oriented CLI command surface

What that means for your team:

- less setup drift
- less repeated environment debugging
- faster first-use experience for new teammates

If you need the technical detail behind this:

- [Onboarding Overview](./onboarding/)
- [Shared Docker Foundation](./onboarding/shared-docker-foundation.md)
- [Workspace Command Surface](./onboarding/workspace-command-surface.md)

### 2. Governed Use

Once people are inside the environment, the next question is control:
who owns what, which identity is active, and how agents are allowed to run?

What teams usually want at this stage:

- clear ownership of each workspace and each credential
- a way to switch runtime credentials without rebuilding the environment

What your team gets today:

- a clear ownership model for users, workspaces, and credentials
- per-harness live credential switching for supported runtimes
- an admin control point for user scope and portal access

What that means for your team:

- less ambiguity about which identity is active
- less accidental credential sprawl
- better operator control over how agents run
- a clearer way to separate normal users from portal administrators

If you need the technical detail behind this:

- [Governed Use Overview](./governed-use/)
- [Ownership Model](./governed-use/ownership-model.md)
- [Credential Switch](./governed-use/credential-switch.md)

### 3. Shared Infrastructure With Isolation

When several people share one machine, the real question is safety:
can they work side by side without their projects and environments leaking into
each other?

What teams usually want at this stage:

- clear workspace isolation
- persistent workspace runtime state
- safe backend and driver switching

What your team gets today:

- a defined isolation boundary for each workspace
- persistent runtime state that stays with the workspace
- backend and driver switching within the same workspace model

What that means for your team:

- zero cross-project collisions
- zero workspace state loss during normal operations
- scaling across different backends and infrastructure models

If you need the technical detail behind this:

- [Shared Infrastructure Overview](./shared-infrastructure/)
- [Isolation Boundary](./shared-infrastructure/isolation-boundary.md)
- [Runtime State And Driver Switching](./shared-infrastructure/runtime-state-and-driver-switching.md)

### 4. Member Exit And Handover

When a member leaves, there are really two different questions. The first is
personal: which parts of that member's own experience should remain theirs to
take away? The second is organizational: which parts of the project context,
environment knowledge, and handover trail must stay with the team?

What teams usually want at this stage:

- clear separation between personal know-how and team-owned context
- project knowledge that stays behind for the next owner
- environment fixes and validation recipes that do not disappear with one
  person
- handover material that helps the next person continue without starting from
  zero

What your team gets today:

- user memory for person-specific working patterns
- workspace memory for project and environment knowledge
- session memory snapshots for handover context
- review-oriented memory flow for deciding what should be retained

What that means for your team:

- personal experience does not have to be confused with team-owned knowledge
- project context is easier to preserve across staffing changes
- handover becomes faster and less fragile

If you need the technical detail behind this:

- [Member Exit And Handover Overview](./member-exit-and-handover/)
- [Personal And Team Context](./member-exit-and-handover/personal-and-team-context.md)

## How To Read The Rest

If you are writing customer-facing material, use this order:

1. this page
2. [Onboarding Overview](./onboarding/)
3. [Governed Use Overview](./governed-use/)
4. [Shared Infrastructure Overview](./shared-infrastructure/)
5. [Member Exit And Handover Overview](./member-exit-and-handover/)
