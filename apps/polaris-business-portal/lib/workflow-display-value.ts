function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/g, "");
}

export function compactWorkspaceDisplayValue(
  value: string,
  workspaceRoot: string,
): string {
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedWorkspaceRoot = normalizePath(workspaceRoot);
  const workflowsRoot = `${normalizedWorkspaceRoot}/workflows`;

  return normalizedValue
    .replaceAll(`${workflowsRoot}/`, "<workflows>/")
    .replaceAll(workflowsRoot, "<workflows>")
    .replaceAll(`${normalizedWorkspaceRoot}/`, "<workspace>/")
    .replaceAll(normalizedWorkspaceRoot, "<workspace>");
}
