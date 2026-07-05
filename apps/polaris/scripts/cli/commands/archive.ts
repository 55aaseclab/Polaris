import { projectOwners } from "../../config/project-ownership.js";
import { parseWorkspaceReference } from "../../config/load.js";
import { archiveWorkspaceOwnedByUser } from "./delete.js";

export async function archiveCommand(projectArg: string, userProfileId?: string): Promise<void> {
  const { project } = parseWorkspaceReference(projectArg);
  if (userProfileId?.trim()) {
    await archiveWorkspaceOwnedByUser(userProfileId.trim(), project);
    return;
  }
  const owners = projectOwners(project);
  if (owners.length === 0) {
    throw new Error(`Workspace '${project}' was not found`);
  }
  if (owners.length > 1) {
    throw new Error(
      `Workspace '${project}' is ambiguous across multiple users (${owners.join(", ")}). Archive it through a user-scoped API route.`,
    );
  }
  await archiveWorkspaceOwnedByUser(owners[0]!, project);
}
