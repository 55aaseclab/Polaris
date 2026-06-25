import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ArrowUpRight,
  FolderKanban,
  PlusCircle,
  RefreshCw,
} from "lucide-react";
import {
  createWorkspace,
  getDefaultUserId,
  getUserProfile,
  getWorkspaceDetail,
  listCredentials,
  listUsers,
  listWorkspaces,
  switchWorkspaceDriver,
  updateUserProfile,
  type PortalCredentialSummary,
  type PortalProfileDetail,
  type PortalProfileSummary,
  type PortalWorkspaceDetail,
  type PortalWorkspaceSummary,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function driverLabel(driver: { backend: string; profile?: string } | null): string {
  if (!driver) {
    return "not-selected";
  }
  return driver.backend === "pod" && driver.profile
    ? `pod:${driver.profile}`
    : driver.backend;
}

function statusTone(state?: string): "default" | "secondary" | "destructive" {
  if (state === "ready") {
    return "default";
  }
  if (state === "error" || state === "failed") {
    return "destructive";
  }
  return "secondary";
}

function useAsyncValue<T>(
  factory: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void factory()
      .then((value) => {
        if (!cancelled) {
          setData(value);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, deps);

  return { data, error, loading };
}

function PortalShell(props: {
  children: ReactNode;
  users: PortalProfileSummary[];
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeUser = props.users.find((user) =>
    location.pathname.includes(`/users/${user.id}/`),
  ) ?? null;
  const activeUserId = activeUser?.id ?? "";
  const {
    data: sidebarWorkspaces,
    loading: sidebarWorkspacesLoading,
  } = useAsyncValue(
    () => activeUserId ? listWorkspaces(activeUserId) : Promise.resolve<PortalWorkspaceSummary[]>([]),
    [activeUserId],
  );
  const currentWorkspaceName = location.pathname.includes("/workspaces/")
    ? decodeURIComponent(location.pathname.split("/workspaces/")[1] ?? "")
    : "";

  function workspaceLink(workspaceName: string): string {
    return `/users/${encodeURIComponent(activeUserId)}/workspaces/${encodeURIComponent(workspaceName)}`;
  }

  function userWorkspaceIndexLink(): string {
    return `/users/${encodeURIComponent(activeUserId)}/workspaces`;
  }

  function onUserChange(nextUserId: string): void {
    if (!nextUserId) {
      return;
    }
    navigate(`/users/${encodeURIComponent(nextUserId)}/workspaces`);
  }

  function onWorkspaceChange(nextWorkspace: string): void {
    if (!nextWorkspace) {
      return;
    }
    navigate(workspaceLink(nextWorkspace));
  }

  return (
    <div className="box-border w-full px-4 py-4 sm:px-6 sm:py-6">
      <div className="grid w-full grid-cols-1 content-start gap-6">
        <Card>
          <CardContent className="grid gap-4 p-5 lg:flex lg:items-center lg:justify-between">
            <div className="grid min-w-0 gap-4 lg:flex lg:w-full lg:items-center lg:justify-between">
              <Link
                to={activeUser ? `/users/${encodeURIComponent(activeUser.id)}/profile` : "/"}
                className="-m-2 min-w-0 rounded-[1rem] p-2 transition hover:bg-muted/40"
              >
                <div className="text-lg font-semibold">Portal</div>
                <div className="truncate text-sm text-muted-foreground">
                  {activeUser
                    ? `${activeUser.name || activeUser.id} · ${activeUser.email}`
                    : "Select a user"}
                </div>
              </Link>
              <div className="grid min-w-0 gap-3 lg:flex lg:min-w-0 lg:items-center">
                <div className="w-full min-w-0 lg:max-w-[22rem]">
                  <Select value={activeUser?.id ?? ""} onValueChange={onUserChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Switch user" />
                    </SelectTrigger>
                    <SelectContent>
                      {props.users.map((user) => (
                        <SelectItem key={user.id} value={user.id}>
                          {user.name || user.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {activeUser && (
                  <div className="w-full min-w-0 lg:hidden">
                    <Select value={currentWorkspaceName} onValueChange={onWorkspaceChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select workspace" />
                      </SelectTrigger>
                      <SelectContent>
                        {sidebarWorkspaces?.map((workspace) => (
                          <SelectItem key={workspace.name} value={workspace.name}>
                            {workspace.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid w-full min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="lg:sticky lg:top-6">
              <Card className="overflow-hidden">
                <CardHeader className="gap-6 pb-6">
                  <div>
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                      <FolderKanban className="h-4 w-4" />
                      Workspaces
                    </div>
                    <div className="grid gap-2">
                      <Link
                        to={`${userWorkspaceIndexLink()}#create-workspace`}
                        className="box-border block w-full min-w-0 rounded-[1.1rem] border border-dashed border-primary/35 bg-primary/5 px-4 py-3 text-sm font-medium text-primary transition hover:bg-primary/10"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <PlusCircle className="h-4 w-4" />
                          <span className="truncate">Add workspace</span>
                        </span>
                      </Link>

                      {sidebarWorkspacesLoading && (
                        <div className="box-border w-full min-w-0 rounded-[1.1rem] border border-border bg-white px-4 py-3 text-sm text-muted-foreground">
                          Loading workspaces...
                        </div>
                      )}

                      {sidebarWorkspaces?.map((workspace) => {
                        const active = location.pathname.includes(
                          `/workspaces/${encodeURIComponent(workspace.name)}`,
                        );
                        return (
                          <Link
                            key={workspace.name}
                            to={workspaceLink(workspace.name)}
                            className={[
                              "box-border block w-full min-w-0 rounded-[1.1rem] border px-4 py-3 transition",
                              active
                                ? "border-primary/30 bg-primary/10 text-foreground"
                                : "border-border bg-white hover:bg-muted/40",
                            ].join(" ")}
                          >
                            <div className="flex min-w-0 items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">
                                  {workspace.name}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {driverLabel(workspace.selectedDriver)}
                                </div>
                              </div>
                              <Badge variant={statusTone(workspace.status?.state)}>
                                {workspace.status?.state ?? "unknown"}
                              </Badge>
                            </div>
                          </Link>
                        );
                      })}

                      {!sidebarWorkspacesLoading && sidebarWorkspaces?.length === 0 && (
                        <div className="box-border w-full min-w-0 rounded-[1.1rem] border border-border bg-white px-4 py-3 text-sm text-muted-foreground">
                          No workspaces yet.
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </div>
          </aside>

          <main className="grid w-full min-w-0 grid-cols-1 content-start gap-6">
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}

function OverviewPage() {
  const { data: users, error, loading } = useAsyncValue(listUsers, []);
  const { data: defaultUserId } = useAsyncValue(getDefaultUserId, []);

  if (defaultUserId) {
    return <Navigate to={`/users/${encodeURIComponent(defaultUserId)}/workspaces`} replace />;
  }

  return (
    <PortalShell users={users ?? []}>
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Select a user route to manage workspaces.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {loading && <p className="text-sm text-muted-foreground">Loading users...</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {users?.map((user) => (
            <Link
              key={user.id}
              to={`/users/${encodeURIComponent(user.id)}/workspaces`}
              className="rounded-2xl border border-border bg-white p-4 hover:bg-muted/40"
            >
              <div className="font-medium">{user.name || user.id}</div>
              <div className="text-sm text-muted-foreground">{user.email}</div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </PortalShell>
  );
}

function WorkspaceIndexPage() {
  const { userId = "" } = useParams();
  const navigate = useNavigate();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data: workspaces, error, loading } = useAsyncValue(
    () => listWorkspaces(userId),
    [userId],
  );
  const [workspaceName, setWorkspaceName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!workspaceName.trim()) {
      return;
    }
    setCreating(true);
    try {
      await createWorkspace(userId, workspaceName.trim());
      navigate(`/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaceName.trim())}`);
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (!workspaces?.length) {
      return;
    }
    void navigate(
      `/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(workspaces[0]!.name)}`,
      { replace: true },
    );
  }, [navigate, userId, workspaces]);

  return (
    <PortalShell users={users ?? []}>
        <Card>
          <CardHeader>
            <CardTitle>Workspaces</CardTitle>
          <CardDescription>
            {loading
              ? "Loading first workspace..."
              : error
                ? error
                : workspaces?.length
                  ? "Opening the first workspace."
                  : `No workspace exists yet for ${userId}.`}
          </CardDescription>
        </CardHeader>
        {!workspaces?.length && (
          <CardContent id="create-workspace">
            <form className="grid w-full gap-4" onSubmit={(event) => void handleCreate(event)}>
              <div className="grid gap-2">
                <Label htmlFor="workspace-name">Workspace name</Label>
                <Input
                  id="workspace-name"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="morpheus"
                />
              </div>
              <Button className="justify-self-start" disabled={creating || workspaceName.trim().length === 0}>
                {creating ? "Provisioning..." : "Create workspace"}
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </PortalShell>
  );
}

function WorkspaceDetailPage() {
  const { userId = "", workspaceName = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data, error, loading } = useAsyncValue(
    () => getWorkspaceDetail(userId, workspaceName),
    [userId, workspaceName],
  );
  const [driver, setDriver] = useState("");
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (data?.selectedDriver) {
      setDriver(driverLabel(data.selectedDriver));
    }
  }, [data]);

  async function handleSwitch(): Promise<void> {
    if (!driver) {
      return;
    }
    setSwitching(true);
    try {
      await switchWorkspaceDriver(userId, workspaceName, driver);
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full grid-cols-1 content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Switch driver</CardTitle>
            <CardDescription>
              Reuse the existing Polaris switch workflow.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid w-full gap-4">
            <Select value={driver} onValueChange={setDriver}>
              <SelectTrigger>
                <SelectValue placeholder="Select driver" />
              </SelectTrigger>
              <SelectContent>
                {data?.availableDrivers.map((item) => {
                  const label = driverLabel(item);
                  return (
                    <SelectItem key={label} value={label}>
                      {item.available ? label : `${label} (create)`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Button className="justify-self-start" onClick={() => void handleSwitch()} disabled={switching || !driver}>
              <RefreshCw className="h-4 w-4" />
              {switching ? "Switching..." : "Switch workspace"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{workspaceName}</CardTitle>
            <CardDescription>
              Current driver: {data ? driverLabel(data.selectedDriver) : "loading"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {loading && <p className="text-sm text-muted-foreground">Loading workspace...</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {data && (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <MetricCard
                    label="Workspace state"
                    value={data.status?.state ?? "unknown"}
                  />
                  <MetricCard
                    label="Daemon pairing"
                    value={data.status?.daemon?.pairing?.state ?? "unknown"}
                  />
                  <MetricCard
                    label="Backend"
                    value={`${data.status?.backend.kind ?? "unknown"} / ${data.status?.backend.profile ?? "unknown"}`}
                  />
                  <MetricCard
                    label="Live target"
                    value={data.liveTarget ?? "not-ready"}
                  />
                </div>
                {data.progress && (
                  <Card className="border-dashed bg-background/80 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Provisioning</CardTitle>
                      <CardDescription>{data.progress.message}</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                      <div className="flex justify-between text-sm text-muted-foreground">
                        <span>{data.progress.phase}</span>
                        <span>{data.progress.percent}%</span>
                      </div>
                      <Progress value={data.progress.percent} />
                    </CardContent>
                  </Card>
                )}
                <div className="box-border grid w-full min-w-0 gap-2 rounded-[1.25rem] border border-border bg-white p-4 text-sm text-muted-foreground">
                  <div className="min-w-0 break-words">{data.status?.details.backendDetail ?? "no backend detail"}</div>
                  <div className="min-w-0 break-words">{data.status?.details.serviceDetail ?? "no service detail"}</div>
                  <div className="min-w-0 break-words">{data.status?.details.userProfileDetail ?? "no profile detail"}</div>
                </div>
                {data.liveTarget && (
                  <a
                    className="inline-flex min-w-0 items-center gap-2 break-all text-sm font-medium text-primary"
                    href={data.liveTarget}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open live target
                    <ArrowUpRight className="h-4 w-4" />
                  </a>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="box-border w-full min-w-0 rounded-[1.25rem] border border-border bg-white p-4">
      <div className="text-sm text-muted-foreground">{props.label}</div>
      <div className="mt-1 min-w-0 break-words font-medium">{props.value}</div>
    </div>
  );
}

function CredentialsPage() {
  const { userId = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data, error, loading } = useAsyncValue(() => listCredentials(userId), [userId]);

  return (
    <PortalShell users={users ?? []}>
      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>
            User-owned credentials for {userId}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {loading && <p className="text-sm text-muted-foreground">Loading credentials...</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data?.map((credential) => <CredentialCard key={credential.id} credential={credential} />)}
        </CardContent>
      </Card>
    </PortalShell>
  );
}

function ProfilePage() {
  const { userId = "" } = useParams();
  const { data: users } = useAsyncValue(listUsers, []);
  const { data: profile, error, loading } = useAsyncValue(() => getUserProfile(userId), [userId]);
  const { data: credentials } = useAsyncValue(() => listCredentials(userId), [userId]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [githubAccount, setGithubAccount] = useState("");
  const [sshComment, setSshComment] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) {
      return;
    }
    setName(profile.name);
    setEmail(profile.email);
    setGithubAccount(profile.githubAccount ?? "");
    setSshComment(profile.sshComment ?? "");
  }, [profile]);

  async function handleSave(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await updateUserProfile(userId, {
        name,
        email,
        githubAccount,
        sshComment,
      });
      setName(updated.name);
      setEmail(updated.email);
      setGithubAccount(updated.githubAccount ?? "");
      setSshComment(updated.sshComment ?? "");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalShell users={users ?? []}>
      <div className="grid w-full grid-cols-1 content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>User profile</CardTitle>
            <CardDescription>
              Edit the active user information for {userId}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && <p className="text-sm text-muted-foreground">Loading profile...</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {profile && (
              <form className="grid gap-4" onSubmit={(event) => void handleSave(event)}>
                <div className="grid gap-2">
                  <Label htmlFor="profile-name">Name</Label>
                  <Input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-email">Email</Label>
                  <Input id="profile-email" value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-github">GitHub account</Label>
                  <Input
                    id="profile-github"
                    value={githubAccount}
                    onChange={(event) => setGithubAccount(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="profile-ssh-comment">SSH comment</Label>
                  <Input
                    id="profile-ssh-comment"
                    value={sshComment}
                    onChange={(event) => setSshComment(event.target.value)}
                  />
                </div>
                <div className="grid gap-2 text-sm text-muted-foreground">
                  <div>User id: {profile.id}</div>
                  <div>SSH mode: {profile.sshMode ?? "unknown"}</div>
                  <div>Tracked workspaces: {profile.workspaces.join(", ") || "none"}</div>
                </div>
                <Button className="justify-self-start" disabled={saving}>
                  {saving ? "Saving..." : "Save profile"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Credentials</CardTitle>
            <CardDescription>
              User-owned credentials for this profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {credentials?.map((credential) => (
              <CredentialCard key={credential.id} credential={credential} />
            ))}
            {!credentials?.length && (
              <p className="text-sm text-muted-foreground">No credentials found.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalShell>
  );
}

function CredentialCard(props: { credential: PortalCredentialSummary }) {
  const { credential } = props;
  return (
    <div className="box-border grid w-full min-w-0 gap-3 rounded-[1.25rem] border border-border bg-white p-4 md:grid-cols-[1fr_auto]">
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <div className="font-medium">{credential.label}</div>
          <Badge variant="outline">{credential.kind}</Badge>
        </div>
        <div className="min-w-0 break-words text-sm text-muted-foreground">{credential.id}</div>
        <div className="min-w-0 break-words text-sm text-muted-foreground">
          Purposes: {credential.purposes.join(", ") || "none"}
        </div>
      </div>
      <div className="flex flex-col items-start gap-2 md:items-end">
        <Badge variant={credential.status === "ready" ? "default" : "secondary"}>
          {credential.status}
        </Badge>
        {credential.paths.map((item) => (
          <div key={item} className="min-w-0 break-words text-xs text-muted-foreground">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<OverviewPage />} />
      <Route path="/users/:userId/profile" element={<ProfilePage />} />
      <Route path="/users/:userId/workspaces" element={<WorkspaceIndexPage />} />
      <Route path="/users/:userId/workspaces/:workspaceName" element={<WorkspaceDetailPage />} />
      <Route path="/users/:userId/credentials" element={<CredentialsPage />} />
    </Routes>
  );
}
