# `@qingniao/surface-wanghai`

Vertical industry surface entry points.

- **Wanghai server runs inside the workspace Docker container** (`:9090`)
- Outer UI only resolves the published portal URL and opens embed/external

Use `planOpenWanghaiPortal` to open the Polaris shell route. Polaris issues a
short-lived launch ticket and proxies the portal through its authenticated
gateway; callers must not construct a direct Wanghai port URL.
