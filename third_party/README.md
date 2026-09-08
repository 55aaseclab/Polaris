# Polaris third-party components

This directory contains pinned submodules and domain-pack sources used by
Polaris.  The parent repository records only the submodule commit; each
submodule must be changed and committed in its own repository first.

## Domain packs

- `afa-dtc-skills` provides the AFA direct-to-consumer skills and its Polaris
  domain pack.
- `syssec-research-skills` provides the systems-security research skills and
  its Polaris domain pack.
- `coursework-vaults/polaris-domain-pack` is the local coursework Vault pack.

## Optional execution backend

`social-auto-upload` is a pinned optional backend for the Polaris
`tools/social-publish` contract.  Its own web routes and credentials are not a
Polaris control plane.  The public publish tool remains validation-first and
integrated execution stays behind a Polaris durable action.

The parent repository does not vendor generated virtual environments, caches,
tokens, cookies, customer data, or provider state from these components.
