/**
 * User-management contracts for shell `/settings/user`.
 * Matches polaris `/api/polaris-user`.
 */

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
    /** coding | vertical | both — product entitlement. */
    line: string | null;
  };
  credentials: Array<{
    id: string;
    label: string;
    kind: string;
    status: string;
    paths: string[];
  }>;
}

/** Pages/modules to migrate out of patched Paseo into shell UI. */
export const SHELL_USER_MIGRATION_SOURCES = [
  "packages/paseo/source/packages/app/src/screens/settings/polaris-user-page.tsx",
  "packages/paseo/source/packages/app/src/lib/polaris-authing.ts",
  "packages/paseo/source/packages/polaris-auth-client",
  "packages/paseo/source/packages/app/src/components/create-polaris-host-modal.tsx",
] as const;
