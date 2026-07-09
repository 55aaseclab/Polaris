import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PortalWorkspacePaseoDiagnostic, PortalWorkspaceSummary } from "@/lib/api";

type Props = {
  t: (key: string) => string;
  selectedWorkspacesError: string | null;
  selectedWorkspacesLoading: boolean;
  visibleSelectedWorkspaces: PortalWorkspaceSummary[];
  selectedAdminUserId: string;
  paseoActionState: Record<string, "loading" | "restarting" | undefined>;
  paseoDiagnostics: Record<string, PortalWorkspacePaseoDiagnostic | undefined>;
  adminWorkspaceStateKey: (userId: string, workspaceName: string) => string;
  driverLabel: (driver: { backend: string; profile?: string } | null) => string;
  translatePaseoWebState: (
    value: "unavailable" | "pairing-required" | "connectable" | undefined,
    t: (key: string) => string,
  ) => string;
  translatePaseoDaemonState: (
    value: "absent" | "pending" | "ready" | "unknown" | undefined,
    t: (key: string) => string,
  ) => string;
  onLoadPaseoDiagnostic: (workspaceName: string) => void;
  onRestartPaseoDaemon: (workspaceName: string) => void;
};

export default function AdminPaseoTab(props: Props) {
  const {
    t,
    selectedWorkspacesError,
    selectedWorkspacesLoading,
    visibleSelectedWorkspaces,
    selectedAdminUserId,
    paseoActionState,
    paseoDiagnostics,
    adminWorkspaceStateKey,
    driverLabel,
    translatePaseoWebState,
    translatePaseoDaemonState,
    onLoadPaseoDiagnostic,
    onRestartPaseoDaemon,
  } = props;

  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle className="text-base">{t("admin_user_tab_paseo")}</CardTitle>
        <CardDescription>{t("paseo_info")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {selectedWorkspacesError ? (
          <p className="text-sm text-destructive">{selectedWorkspacesError}</p>
        ) : null}
        {!selectedWorkspacesLoading
          && !selectedWorkspacesError
          && visibleSelectedWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("admin_workspace_empty")}</p>
          ) : null}
        {visibleSelectedWorkspaces.map((workspace) => {
          const workspaceStateKey = adminWorkspaceStateKey(
            selectedAdminUserId,
            workspace.name,
          );
          return (
            <div
              key={`paseo-${workspaceStateKey}`}
              className="grid gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{workspace.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {translatePaseoWebState(workspace.status?.paseo?.web, t)}
                  </div>
                </div>
                <Badge variant="outline">
                  {driverLabel(workspace.status?.driver?.selected ?? workspace.status?.runtime?.selectedDriver ?? null)}
                </Badge>
              </div>
              <div className="grid gap-1">
                <div className="text-xs text-muted-foreground">
                  {t("admin_paseo_web")}
                </div>
                <div className="break-all text-sm">
                  {translatePaseoWebState(workspace.status?.paseo?.web, t)}
                </div>
              </div>
              <div className="grid gap-1">
                <div className="text-xs text-muted-foreground">
                  {t("admin_paseo_daemon")}
                </div>
                <div className="break-all text-sm">
                  {translatePaseoDaemonState(workspace.status?.paseo?.daemon, t)}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(paseoActionState[workspaceStateKey])}
                  onClick={() => onLoadPaseoDiagnostic(workspace.name)}
                >
                  {paseoActionState[workspaceStateKey] === "loading"
                    ? t("refreshing")
                    : t("admin_paseo_status_button")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(paseoActionState[workspaceStateKey])}
                  onClick={() => onRestartPaseoDaemon(workspace.name)}
                >
                  {paseoActionState[workspaceStateKey] === "restarting"
                    ? t("admin_paseo_restarting_button")
                    : t("admin_paseo_restart_button")}
                </Button>
              </div>
              {paseoDiagnostics[workspaceStateKey] ? (
                <details className="rounded-xl border border-border/70 bg-background">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
                    {t("admin_paseo_status_raw")}
                  </summary>
                  <pre className="overflow-x-auto border-t border-border/70 p-3 text-xs leading-5">
                    {paseoDiagnostics[workspaceStateKey]?.daemonStatusRaw}
                  </pre>
                </details>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
