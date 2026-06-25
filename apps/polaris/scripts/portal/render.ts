import type {
  PortalCredentialSummary,
  PortalDriverTarget,
  PortalProfileSummary,
  PortalProvisionProgress,
  PortalWorkspaceDetail,
  PortalWorkspaceSummary,
  PortalSessionContext,
} from "../core/portal.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function driverLabel(target: PortalDriverTarget): string {
  return target.backend === "pod" && target.profile
    ? `pod:${target.profile}`
    : target.backend;
}

function progressMarkup(progress: PortalProvisionProgress | null): string {
  if (!progress) {
    return "<p class=\"muted\">No provisioning job is running.</p>";
  }
  return `
    <div class="progress-card">
      <div class="progress-row">
        <strong>${escapeHtml(progress.phase)}</strong>
        <span>${progress.percent}%</span>
      </div>
      <progress value="${progress.percent}" max="100"></progress>
      <p>${escapeHtml(progress.message)}</p>
      <p class="muted">Updated ${escapeHtml(progress.updatedAt)}</p>
    </div>
  `;
}

function shell(title: string, content: string, session?: PortalSessionContext): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --panel: #fffdf7;
      --text: #171717;
      --muted: #6a6a6a;
      --accent: #166534;
      --accent-soft: #dcfce7;
      --border: #d8d3c7;
      --danger: #991b1b;
    }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, var(--bg), #f0eadf);
      color: var(--text);
    }
    .wrap {
      max-width: 1080px;
      margin: 0 auto;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: start;
      margin-bottom: 24px;
    }
    h1, h2, h3, p { margin-top: 0; }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      gap: 16px;
    }
    .grid.cols-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      box-shadow: 0 10px 24px rgba(23, 23, 23, 0.05);
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    form.inline { display: inline; }
    button, input, select, textarea {
      font: inherit;
    }
    button, input[type="submit"] {
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 12px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .secondary {
      background: #e8e2d6;
      color: var(--text);
    }
    .danger {
      background: var(--danger);
      color: white;
    }
    input, select, textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      background: white;
      margin: 6px 0 12px;
    }
    textarea { min-height: 120px; }
    progress {
      width: 100%;
      height: 16px;
    }
    .pill {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
    }
    .list {
      display: grid;
      gap: 12px;
    }
    .progress-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p class="muted">Polaris portal</p>
      </div>
      <div class="panel">
        <p><strong>${escapeHtml(session?.polarisUserId ?? "anonymous")}</strong></p>
        <p class="muted">${escapeHtml(session?.email ?? "no email")}</p>
        <p>${session?.isAdmin ? '<span class="pill">admin</span>' : '<span class="pill">user</span>'}</p>
      </div>
    </header>
    ${content}
  </div>
</body>
</html>`;
}

function link(prefix: string, parts: string[]): string {
  return `${prefix}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

export function renderWorkspaceIndexPage(params: {
  session: PortalSessionContext;
  user: PortalProfileSummary;
  workspaces: PortalWorkspaceSummary[];
}): string {
  const { session, user, workspaces } = params;
  const rows = workspaces.map((workspace) => `
    <tr>
      <td><a href="${link(`/users/${encodeURIComponent(user.id)}/workspaces`, [workspace.name])}">${escapeHtml(workspace.name)}</a></td>
      <td>${escapeHtml(workspace.status?.state ?? "unknown")}</td>
      <td>${escapeHtml(workspace.selectedDriver ? driverLabel(workspace.selectedDriver) : "not-selected")}</td>
      <td>${escapeHtml(workspace.liveTarget ?? "none")}</td>
    </tr>
  `).join("");
  const createAction = `/users/${encodeURIComponent(user.id)}/workspaces`;
  return shell(`User ${user.id} workspaces`, `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Workspaces</h2>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>Driver</th><th>Live target</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=\"4\" class=\"muted\">No workspaces yet.</td></tr>"}</tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Create workspace</h2>
        <form method="post" action="${createAction}">
          <label>Workspace name</label>
          <input name="workspaceName" placeholder="morpheus" required>
          <label>Primary driver</label>
          <select name="driver">
            <option value="docker">docker</option>
            <option value="pod:gvisor">pod:gvisor</option>
            <option value="pod:data-container">pod:data-container</option>
            <option value="kubevirt-vm">kubevirt-vm</option>
          </select>
          <button type="submit">Provision</button>
        </form>
      </div>
    </div>
  `, session);
}

export function renderWorkspaceDetailPage(params: {
  session: PortalSessionContext;
  user: PortalProfileSummary;
  workspace: PortalWorkspaceDetail;
}): string {
  const { session, user, workspace } = params;
  const driverForms = workspace.availableDrivers.map((driver) => `
    <form class="inline" method="post" action="${link(`/users/${encodeURIComponent(user.id)}/workspaces`, [workspace.name, "switch"])}">
      <input type="hidden" name="driver" value="${escapeHtml(driverLabel(driver))}">
      <button class="${driver.available ? "" : "secondary"}" type="submit">${escapeHtml(driverLabel(driver))}${driver.available ? "" : " (create)"}</button>
    </form>
  `).join(" ");
  const bindings = workspace.credentialBindings.length
    ? workspace.credentialBindings.map((binding) => `<li>${escapeHtml(binding.purpose)} -> ${escapeHtml(binding.credentialId)}${binding.required ? "" : " (optional)"}</li>`).join("")
    : "<li class=\"muted\">No bindings loaded.</li>";
  return shell(`Workspace ${workspace.name}`, `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Status</h2>
        <p><strong>${escapeHtml(workspace.status?.state ?? "unknown")}</strong></p>
        <p class="muted">Backend: ${escapeHtml(workspace.status?.backend.kind ?? "unknown")} / ${escapeHtml(workspace.status?.backend.profile ?? "unknown")}</p>
        <p class="muted">Daemon: ${escapeHtml(workspace.status?.daemon?.manager?.state ?? "unknown")} / ${escapeHtml(workspace.status?.daemon?.pairing?.state ?? "unknown")}</p>
        <p>Live target: ${workspace.liveTarget ? `<a href="${escapeHtml(workspace.liveTarget)}">${escapeHtml(workspace.liveTarget)}</a>` : "<span class=\"muted\">none</span>"}</p>
        <div>Progress: ${progressMarkup(workspace.progress)}</div>
        <div class="list">${driverForms}</div>
      </div>
      <div class="panel">
        <h2>Details</h2>
        <p>User: ${escapeHtml(user.id)}</p>
        <p>Current driver: ${escapeHtml(workspace.selectedDriver ? driverLabel(workspace.selectedDriver) : "not-selected")}</p>
        <h3>Credential bindings</h3>
        <ul>${bindings}</ul>
        <h3>Runtime</h3>
        <ul>
          <li>${escapeHtml(workspace.status?.details.backendDetail ?? "no backend detail")}</li>
          <li>${escapeHtml(workspace.status?.details.serviceDetail ?? "no service detail")}</li>
          <li>${escapeHtml(workspace.status?.details.userProfileDetail ?? "no profile detail")}</li>
        </ul>
      </div>
    </div>
  `, session);
}

export function renderCredentialsPage(params: {
  session: PortalSessionContext;
  user: PortalProfileSummary;
  credentials: PortalCredentialSummary[];
}): string {
  const { session, user, credentials } = params;
  const rows = credentials.map((credential) => `
    <tr>
      <td>${escapeHtml(credential.id)}</td>
      <td>${escapeHtml(credential.kind)}</td>
      <td>${escapeHtml(credential.label)}</td>
      <td>${escapeHtml(credential.purposes.join(", "))}</td>
      <td>${escapeHtml(credential.status)}</td>
    </tr>
  `).join("");
  return shell(`Credentials for ${user.id}`, `
    <div class="grid cols-2">
      <div class="panel">
        <h2>Credentials</h2>
        <table>
          <thead><tr><th>ID</th><th>Kind</th><th>Label</th><th>Purposes</th><th>Status</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=\"5\" class=\"muted\">No credentials found.</td></tr>"}</tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Create or update</h2>
        <p class="muted">POST a JSON payload to the API endpoint or use this form to create a credential shell.</p>
        <form method="post" action="${link(`/users/${encodeURIComponent(user.id)}/credentials`, ["create"])}">
          <label>Credential id</label>
          <input name="credentialId" required>
          <label>Kind</label>
          <select name="kind">
            <option value="codex-auth">codex-auth</option>
            <option value="ssh-key">ssh-key</option>
            <option value="api-key">api-key</option>
            <option value="git-https-token">git-https-token</option>
            <option value="kubeconfig">kubeconfig</option>
            <option value="cloud-token">cloud-token</option>
          </select>
          <label>Label</label>
          <input name="label" required>
          <label>Purposes (comma separated)</label>
          <input name="purposes" placeholder="agent-auth,git-auth" required>
          <button type="submit">Save</button>
        </form>
      </div>
    </div>
  `, session);
}

export function renderProvisionPage(params: {
  session: PortalSessionContext;
  user: PortalProfileSummary;
  workspace: PortalWorkspaceDetail;
}): string {
  const { session, user, workspace } = params;
  return shell(`Provisioning ${workspace.name}`, `
    <div class="panel">
      <h2>${escapeHtml(workspace.name)}</h2>
      ${progressMarkup(workspace.progress)}
      <p>Return to <a href="${link(`/users/${encodeURIComponent(user.id)}/workspaces`, [workspace.name])}">workspace details</a>.</p>
    </div>
  `, session);
}
