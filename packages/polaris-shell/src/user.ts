/**
 * User-management contracts for shell `/settings/user`.
 * Matches polaris `/api/polaris-user` and `user defaults` CLI shape.
 */

export interface ShellWorkspaceDefaults {
  docker: {
    runtime: {
      baseImage: string | null;
    };
  };
}

export interface ShellUserPageModel {
  profile: {
    id: string;
    name?: string;
    email?: string;
  };
  session: {
    userId: string;
    authingUserId: string;
    authingUsername: string | null;
    role: string;
    /** free | pro — feature richness (reserved). */
    plan: string | null;
    /** coding | vertical — product line. */
    line: string | null;
  };
  workspaceDefaults: ShellWorkspaceDefaults;
}

export function emptyWorkspaceDefaults(): ShellWorkspaceDefaults {
  return {
    docker: {
      runtime: {
        baseImage: null,
      },
    },
  };
}

export function formatDockerBaseImage(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "未设置";
}

/** Pages/modules to migrate out of patched Paseo into shell UI. */
export const SHELL_USER_MIGRATION_SOURCES = [
  "apps/paseo/source/packages/app/src/screens/settings/polaris-user-page.tsx",
  "apps/paseo/source/packages/app/src/lib/polaris-authing.ts",
  "apps/paseo/source/packages/polaris-auth-client",
  "apps/paseo/source/packages/app/src/components/create-polaris-host-modal.tsx",
] as const;
