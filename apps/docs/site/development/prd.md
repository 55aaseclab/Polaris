# Polaris workflow observer requirements

Display the current workspace’s workflow definitions, graphs, searchable work-item states and run progress in the native portal. The service is read-only, returns no data for a mismatched workspace, and starts empty. Operators can publish observations separately from application code.

Expose read-only app-owned inventory metadata to Praxis Settings. Identify Polaris as runtime and exclude it from the workbench card program.


## Runtime trace metadata

Expose the existing approved workspace snapshot through a read-only metadata projection. Preserve run/flow IDs, states, actual creation/start/update times and versions when recorded, step IDs/state/version and opaque artifact references. Missing fields remain unknown; bounded step/artifact lists retain total counts. Trace coverage is runtime-observation, separate from committed app lifecycle. Do not return commands, logs, diagnostic bodies, input/output, credentials or executable flows.

## App-owned Praxis integration

This app owns its reviewed `praxis-integration.mjs`: native entry policy, typed business operations and MCP guidance where supported. Praxis loads that declaration from the installed source and retains authorization, signing, policy leases and audit. Installation does not grant access or start a backend. Existing native interfaces, data ownership and recovery boundaries remain in force.
