import {
  resolveShellHostActions,
  type ShellHostSummary,
  type ShellSession,
} from "../api.js";
import { normalizeAuthingLoginErrorMessage, AUTHING_LOGIN_ERROR_MESSAGE } from "../auth-errors.js";
import {
  buildCreatedHostSurfaceHref,
  DEFAULT_POLARIS_VAULT_PATH,
  resolveCodingSurfaceUrl,
  validatePolarisHostName,
} from "../create-host.js";
import {
  clampFloatingButtonPosition,
  defaultFloatingButtonPosition,
  didFloatingButtonDrag,
  type FloatingButtonBounds,
} from "../floating-button.js";
import {
  resolveAllowedVaultLines,
  type PolarisVaultLine,
} from "../product.js";
import { SHELL_HOST_API } from "../hosts.js";
import { renderPaseoEmbedPage } from "../paseo-embed.js";
import { createPkceChallenge } from "../pkce.js";
import { buildPortalRequestHeaders } from "../request-headers.js";
import {
  clearTransientValue,
  readTransientValue,
  writeTransientValue,
} from "../transient-auth.js";
import { resolveWelcomeAction } from "../welcome.js";
import { renderWanghaiEmbedPage } from "../wanghai-embed.js";

const SESSION_TOKEN_KEY = "polaris_authing_session";
const ID_TOKEN_KEY = "polaris_authing_id_token";
const PKCE_VERIFIER_KEY = "polaris_authing_pkce_verifier";
const PKCE_STATE_KEY = "polaris_authing_state";
const RETURN_PATH_KEY = "polaris_authing_return_path";
const REDIRECT_URI_KEY = "polaris_authing_redirect_uri";
const SHELL_SCROLL_ROOT_CLASS = "shell-scroll-root";
const SURFACE_BACK_BUTTON_MARGIN = 14;
const SURFACE_BACK_BUTTON_DRAG_THRESHOLD = 4;

interface AuthingConfig {
  authMode: ShellSession["authMode"];
  appId?: string;
  authorizationUrl?: string;
  redirectUri?: string;
  logoutUrl?: string;
  logoutRedirectUri?: string;
  paseoAppBaseUrl?: string;
  signInUrl?: string;
  signOutUrl?: string;
}

interface ShellUserResponse {
  profile: {
    id: string;
    name?: string;
    email?: string;
  };
  session: ShellSession & {
    userId: string;
    authingPhoneNumber?: string | null;
  };
  credentials: ShellCredential[];
}

interface ShellCredential {
  id: string;
  label: string;
  kind: string;
  status: string;
  paths: string[];
}

interface ShellCredentialRecord {
  credential: {
    id: string;
    label: string;
  };
  files: Array<{
    key: string;
    sourcePath: string;
    content: string;
  }>;
}

interface ApiError extends Error {
  status: number;
}

const app = requiredElement("app");
let currentSession: ShellSession | null = null;
let surfaceBackButtonCleanup: (() => void) | null = null;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing shell element #${id}`);
  }
  return element;
}

function readCookieValue(key: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`));
  if (!entry) {
    return null;
  }
  return decodeURIComponent(entry.slice(key.length + 1).trim()) || null;
}

function cookieAttributes(): string {
  return `path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

function writeCookieValue(key: string, value: string): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${key}=${encodeURIComponent(value)}; ${cookieAttributes()}`;
}

function clearCookieValue(key: string): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = `${key}=; Max-Age=0; ${cookieAttributes()}`;
}

function token(): string | null {
  const value = sessionStorage.getItem(SESSION_TOKEN_KEY)?.trim()
    || readCookieValue(SESSION_TOKEN_KEY)?.trim();
  return value ? value.replace(/^Bearer\s+/i, "") : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = buildPortalRequestHeaders(init?.headers, token());
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    ) as ApiError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSession(): Promise<ShellSession | null> {
  try {
    const session = await request<ShellSession>("/session");
    currentSession = session;
    return session;
  } catch (error) {
    if (isApiError(error) && (error.status === 401 || error.status === 403)) {
      if (token()) {
        await delay(250);
        try {
          const session = await request<ShellSession>("/session");
          currentSession = session;
          return session;
        } catch (retryError) {
          if (isApiError(retryError) && (retryError.status === 401 || retryError.status === 403)) {
            currentSession = null;
            return null;
          }
          throw retryError;
        }
      }
      currentSession = null;
      return null;
    }
    throw error;
  }
}

function isApiError(value: unknown): value is ApiError {
  return value instanceof Error && typeof (value as Partial<ApiError>).status === "number";
}

function shellPath(): string {
  return location.pathname.replace(/\/+$/, "") || "/";
}

function navigate(path: string, replace = false): void {
  if (replace) {
    history.replaceState({}, "", path);
  } else {
    history.pushState({}, "", path);
  }
  void render();
}

async function resolvePaseoUrl(
  path: string,
  reconnectTarget?: string | null,
): Promise<string> {
  const config = await authingConfig().catch(() => null);
  return resolveCodingSurfaceUrl({
    href: path,
    paseoAppBaseUrl: config?.paseoAppBaseUrl,
    currentOrigin: location.origin,
    reconnectTarget,
  });
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shellFrame(content: string, active: "hosts" | "user" | null = null): string {
  return `<div class="shell">
    <header class="topbar">
      <a class="brand" href="/hosts" data-nav>POLARIS</a>
      <nav class="nav" aria-label="主导航">
        <a href="/hosts" data-nav class="${active === "hosts" ? "active" : ""}">主机</a>
        <a href="/settings/user" data-nav class="${active === "user" ? "active" : ""}">账户</a>
      </nav>
    </header>
    ${content}
  </div>`;
}

function setShellScrollRoot(enabled: boolean): void {
  document.documentElement.classList.toggle(SHELL_SCROLL_ROOT_CLASS, enabled);
}

function renderShell(content: string, active: "hosts" | "user" | null = null): void {
  setShellScrollRoot(true);
  app.innerHTML = shellFrame(content, active);
}

function renderLoading(label = "正在加载…"): void {
  renderShell(`<div class="empty">${escapeHtml(label)}</div>`);
}

function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  renderShell(`<div class="error">${escapeHtml(message)}</div>`);
}

async function render(): Promise<void> {
  if (surfaceBackButtonCleanup) {
    surfaceBackButtonCleanup();
    surfaceBackButtonCleanup = null;
  }
  const path = shellPath();
  if (path === "/welcome") {
    await renderWelcome();
    return;
  }
  if (path === "/auth/callback") {
    await renderAuthCallback();
    return;
  }

  renderLoading();
  try {
    const session = await loadSession();
    if (!session || !session.authenticated) {
      navigate("/welcome", true);
      return;
    }
    if (!session.polarisUserId) {
      await ensureCurrentUser(session);
      navigate("/hosts", true);
      return;
    }
    if (path === "/" || path === "/settings") {
      navigate("/hosts", true);
      return;
    }
    if (path === "/settings/user") {
      await renderUserPage();
      return;
    }
    if (path === "/hosts" || path === "/hosts/") {
      await renderHostsPage();
      return;
    }
    const hostMatch = path.match(/^\/hosts\/([^/]+)$/);
    if (hostMatch) {
      navigate("/hosts", true);
      return;
    }
    const codingMatch = path.match(/^\/v\/([^/]+)\/coding$/);
    if (codingMatch) {
      await renderCodingSurface(decodeURIComponent(codingMatch[1]));
      return;
    }
    const portalMatch = path.match(/^\/v\/([^/]+)\/wanghai$/);
    if (portalMatch) {
      await renderWanghaiPortal(decodeURIComponent(portalMatch[1]));
      return;
    }
    navigate("/hosts", true);
  } catch (error) {
    renderError(error);
  }
}

async function renderWelcome(): Promise<void> {
  try {
    const session = await loadSession();
    const config = session?.authenticated ? null : await authingConfig();
    const action = resolveWelcomeAction({
      authMode: config?.authMode ?? session?.authMode ?? "authing-browser-session",
      session,
    });
    if (action === "navigate-hosts") {
      if (session?.authenticated && !session.polarisUserId) {
        await ensureCurrentUser(session);
      }
      navigate("/hosts", true);
      return;
    }
    if (action === "ensure-user-and-hosts") {
      if (!session.polarisUserId) {
        await ensureCurrentUser(session);
      }
      navigate("/hosts", true);
      return;
    }
    await beginSignIn(config ?? undefined);
  } catch (error) {
    renderError(error);
  }
}

async function renderAuthCallback(): Promise<void> {
  renderLoading("正在完成登录…");
  try {
    const returnPath = await completeSignIn();
    const session = await loadSession();
    if (!session) {
      throw new Error("登录会话不可用");
    }
    if (!session.polarisUserId) {
      await ensureCurrentUser(session);
    }
    navigate(returnPath === "/welcome" ? "/hosts" : returnPath, true);
  } catch (error) {
    const message = normalizeAuthingLoginErrorMessage(error);
    renderShell(`<section class="hero">
      <h1>${escapeHtml(message)}</h1>
      <div class="actions"><button type="button" data-action="sign-in">重新登录</button></div>
    </section>`);
  }
}

async function renderHostsPage(): Promise<void> {
  const session = requireSession();
  renderShell(`<section class="host-grid" id="host-list">
      ${createHostCard(session)}
      <div class="empty">正在加载主机…</div>
    </section>`, "hosts");
  bindCreateHostForm(session);
  const payload = await request<{ hosts: ShellHostSummary[] }>(SHELL_HOST_API.listHosts);
  renderHostList(payload.hosts, session);
}

function renderHostList(hosts: ShellHostSummary[], session: ShellSession): void {
  const list = requiredElement("host-list");
  if (hosts.length === 0) {
    list.innerHTML = createHostCard(session);
    bindCreateHostForm(session);
    return;
  }
  list.innerHTML = `${createHostCard(session)}${hosts.map((host) => hostCard(host, session)).join("")}`;
  bindCreateHostForm(session);
  for (const card of list.querySelectorAll<HTMLElement>("[data-host-name]")) {
    bindHostActions(card, hosts, session);
  }
}

function createHostCard(session: Pick<ShellSession, "line">): string {
  const allowedLines = resolveAllowedVaultLines(session.line);
  return `<section class="card host-create">
      <h2>创建主机</h2>
      <form class="host-create-form" data-form="create-host">
        <div class="field">
          <input name="hostName" required maxlength="63" placeholder="例如 sample-vault" aria-label="主机名称" />
        </div>
        <div class="host-create-options-row">
          <div class="host-create-line-group">
            <p class="muted host-create-label">产品线</p>
            <div class="line-options">
              ${allowedLines.map((line, index) => `<label class="check-row line-choice">
                  <input type="checkbox" name="line" value="${escapeHtml(line)}" ${index === 0 ? "checked" : ""} />
                  <span>${escapeHtml(vaultLineLabel(line))}</span>
                </label>`).join("")}
            </div>
          </div>
          <label class="check-row create-default-choice">
            <input type="checkbox" name="createDefaultProject" checked />
            <span class="check-copy">
              <span>创建默认库</span>
              <span class="muted">${escapeHtml(DEFAULT_POLARIS_VAULT_PATH)}</span>
            </span>
          </label>
        </div>
        <div class="actions">
          <button type="submit">创建并启动</button>
        </div>
      </form>
    </section>`;
}

function hostCard(host: ShellHostSummary, session: ShellSession): string {
  const driverStatus = host.status?.driver?.status || "未就绪";
  const surfaceStatus = host.serverId
    ? `Paseo ${escapeHtml(host.serverId)}`
    : host.wanghaiId
      ? "Wanghai 网关已就绪"
      : "等待库服务就绪";
  const actions = resolveShellHostActions({
    session,
    host,
  });
  const coding = actions.find((action) => action.kind === "open-coding");
  const wanghai = actions.find((action) => action.kind === "open-wanghai");
  const canStop = driverStatus === "running" || driverStatus === "starting";
  return `<article class="card" data-host-name="${escapeHtml(host.name)}">
    <div class="card-head">
      <div>
        <h2>${escapeHtml(host.name)}</h2>
        <p class="muted">${surfaceStatus}</p>
      </div>
      <span class="status ${driverStatus === "running" ? "running" : ""}">${escapeHtml(driverStatus)}</span>
    </div>
    <div class="actions">
      ${coding ? `<button type="button" data-action="open-coding" data-href="${escapeHtml(coding.href)}">进入 coding 工作面</button>` : ""}
      ${wanghai ? `<button type="button" data-action="open-wanghai" data-href="${escapeHtml(wanghai.href)}">进入 vertical 工作面</button>` : ""}
      ${canStop
        ? `<button type="button" class="secondary" data-action="stop">停止</button>`
        : `<button type="button" class="secondary" data-action="start">启动</button>`}
      <button type="button" class="danger" data-action="delete">删除</button>
    </div>
  </article>`;
}

async function renderWanghaiPortal(wanghaiId: string): Promise<void> {
  const session = requireSession();
  const payload = await request<{ hosts: ShellHostSummary[] }>(SHELL_HOST_API.listHosts);
  const host = payload.hosts.find((item) => item.wanghaiId === wanghaiId);
  if (!host) {
    navigate("/hosts", true);
    return;
  }
  const action = resolveShellHostActions({
    session,
    host,
  }).find((item) => item.kind === "open-wanghai");
  if (!action || action.kind !== "open-wanghai") {
    navigate("/hosts", true);
    return;
  }
  const launch = await request<{ portalUrl: string }>(
    SHELL_HOST_API.launchWanghai(wanghaiId),
    { method: "POST" },
  );
  setShellScrollRoot(false);
  app.innerHTML = renderWanghaiEmbedPage({
    hostName: host.name,
    portalUrl: launch.portalUrl,
    backHref: "/hosts",
  });
  const backButton = app.querySelector<HTMLAnchorElement>(".portal-shell-back");
  if (backButton) {
    surfaceBackButtonCleanup = bindDraggableSurfaceBackButton(backButton);
  }
}

async function renderCodingSurface(serverId: string): Promise<void> {
  const payload = await request<{ hosts: ShellHostSummary[] }>(SHELL_HOST_API.listHosts);
  const host = payload.hosts.find((item) => item.serverId === serverId);
  if (!host) {
    navigate("/hosts", true);
    return;
  }
  const paseoUrl = await resolvePaseoUrl(
    `/v/${encodeURIComponent(serverId)}/coding`,
    host.status?.paseo?.reconnectTarget ?? null,
  );
  setShellScrollRoot(false);
  app.innerHTML = renderPaseoEmbedPage({
    hostName: host.name,
    paseoUrl,
  });
}

function bindDraggableSurfaceBackButton(button: HTMLAnchorElement): () => void {
  let activePointerId: number | null = null;
  let pointerOffsetX = 0;
  let pointerOffsetY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let suppressClick = false;

  const bounds = (): FloatingButtonBounds => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    elementWidth: button.offsetWidth,
    elementHeight: button.offsetHeight,
    margin: SURFACE_BACK_BUTTON_MARGIN,
  });

  const applyPosition = (x: number, y: number): void => {
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.style.right = "auto";
    button.style.bottom = "auto";
  };

  const resetToDefault = (): void => {
    const position = defaultFloatingButtonPosition(bounds());
    applyPosition(position.x, position.y);
  };

  const clampCurrentPosition = (): void => {
    const rect = button.getBoundingClientRect();
    const position = clampFloatingButtonPosition(
      { x: rect.left, y: rect.top },
      bounds(),
    );
    applyPosition(position.x, position.y);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId !== event.pointerId) {
      return;
    }
    const next = clampFloatingButtonPosition(
      {
        x: event.clientX - pointerOffsetX,
        y: event.clientY - pointerOffsetY,
      },
      bounds(),
    );
    applyPosition(next.x, next.y);
    if (didFloatingButtonDrag({
      startX: dragStartX,
      startY: dragStartY,
      currentX: event.clientX,
      currentY: event.clientY,
    }, SURFACE_BACK_BUTTON_DRAG_THRESHOLD)) {
      button.classList.add("is-dragging");
      suppressClick = true;
    }
  };

  const releasePointer = (event?: PointerEvent): void => {
    if (event && activePointerId !== event.pointerId) {
      return;
    }
    if (activePointerId !== null) {
      try {
        button.releasePointerCapture(activePointerId);
      } catch {
        // Ignore stale pointer capture during cleanup.
      }
    }
    activePointerId = null;
    button.classList.remove("is-dragging");
  };

  const onPointerUp = (event: PointerEvent): void => {
    releasePointer(event);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const rect = button.getBoundingClientRect();
    activePointerId = event.pointerId;
    pointerOffsetX = event.clientX - rect.left;
    pointerOffsetY = event.clientY - rect.top;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    suppressClick = false;
    button.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onClick = (event: MouseEvent): void => {
    if (!suppressClick) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  };

  const onResize = (): void => {
    if (!button.isConnected) {
      return;
    }
    if (!button.style.left || !button.style.top) {
      resetToDefault();
      return;
    }
    clampCurrentPosition();
  };

  button.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("resize", onResize);
  button.addEventListener("click", onClick);
  resetToDefault();

  return () => {
    releasePointer();
    button.removeEventListener("pointerdown", onPointerDown);
    button.removeEventListener("click", onClick);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("resize", onResize);
  };
}

async function renderUserPage(): Promise<void> {
  const data = await request<ShellUserResponse>(SHELL_HOST_API.currentUser);
  currentSession = data.session;
  const profileRows = [
    ["用户名称", data.profile.name || data.session.authingUsername || "未设置"],
    ["邮箱", data.profile.email || "未设置"],
    ["用户 ID", data.session.userId],
    ["Authing ID", data.session.authingUserId],
    ["角色", data.session.role || "未设置"],
    ["产品线", subscriptionLineLabel(data.session.line)],
    ["套餐", planLabel(data.session.plan)],
  ];
  renderShell(`<section class="stack">
      <section class="stack">
        <h2>基本信息</h2>
        <section class="card"><dl class="rows">${profileRows.map(([label, value]) => row(label, value)).join("")}</dl></section>
      </section>
      <section class="stack">
        <h2>凭证</h2>
        <section class="card"><div class="rows">${credentialRows(data.credentials)}</div></section>
      </section>
      <section class="card"><h2>会话</h2><p>${data.session.authMode === "disabled" ? "本地开发模式使用固定默认用户，无需登录或退出。" : "退出当前 Polaris 会话。"}</p>${data.session.authMode === "disabled" ? "" : '<div class="actions"><button type="button" class="danger" data-action="sign-out">退出登录</button></div>'}</section>
    </section>`, "user");
  bindCredentialButtons(data);
}

function row(label: string, value: string): string {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function credentialRows(credentials: ShellCredential[]): string {
  if (credentials.length === 0) {
    return '<div class="empty">还没有凭证</div>';
  }
  return credentials.map((credential) => `<div class="row">
    <dt>${escapeHtml(credential.label)}</dt>
    <dd>${escapeHtml(credential.paths.join(" · ") || credential.kind)} ${credential.status === "ready" ? `<button type="button" class="secondary" data-action="view-credential" data-credential-id="${escapeHtml(credential.id)}">查看</button>` : `<span class="muted">${escapeHtml(credential.status)}</span>`}</dd>
  </div>`).join("");
}

function bindCredentialButtons(data: ShellUserResponse): void {
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-action='view-credential']")) {
    button.addEventListener("click", () => {
      const credentialId = button.dataset.credentialId;
      if (!credentialId) {
        return;
      }
      void viewCredential(data.session.userId, credentialId);
    });
  }
}

async function viewCredential(userId: string, credentialId: string): Promise<void> {
  try {
    const record = await request<ShellCredentialRecord>(
      `/users/${encodeURIComponent(userId)}/credentials/${encodeURIComponent(credentialId)}`,
    );
    const files = record.files.map((file) => `${file.sourcePath}\n${file.content}`).join("\n\n");
    alert(files || "没有可查看的凭证文件");
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}

function bindCreateHostForm(session: Pick<ShellSession, "line">): void {
  const form = app.querySelector<HTMLFormElement>("[data-form='create-host']");
  if (!form) {
    return;
  }
  const input = form.querySelector<HTMLInputElement>("input[name='hostName']");
  const lineInputs = Array.from(form.querySelectorAll<HTMLInputElement>("input[name='line']"));
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
  const allowedLines = resolveAllowedVaultLines(session.line);
  const syncLineInputs = (source?: HTMLInputElement) => {
    if (source?.checked) {
      for (const lineInput of lineInputs) {
        if (lineInput !== source) {
          lineInput.checked = false;
        }
      }
      return;
    }
    if (!lineInputs.some((lineInput) => lineInput.checked) && source) {
      source.checked = true;
    }
  };
  for (const lineInput of lineInputs) {
    lineInput.addEventListener("change", () => {
      syncLineInputs(lineInput);
    });
  }
  const updateState = () => {
    if (!input || !submit) {
      return;
    }
    const validation = validatePolarisHostName(input.value);
    submit.disabled = !validation.hostName;
  };
  input?.addEventListener("input", updateState);
  updateState();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = new FormData(form).get("hostName");
    const selectedLine = selectedCreateHostLine(lineInputs, allowedLines);
    const createDefaultProject = new FormData(form).get("createDefaultProject") !== null;
    if (typeof name !== "string" || !selectedLine) {
      return;
    }
    const validation = validatePolarisHostName(name);
    if (!validation.hostName || validation.error) {
      if (validation.error) {
        alert(validation.error);
      }
      return;
    }
    void (async () => {
      if (submit) {
        submit.disabled = true;
        submit.textContent = "正在创建";
      }
      try {
        alert("新主机将按照当前订阅产品线创建运行时。");
        await request(SHELL_HOST_API.createHost, {
          method: "POST",
          body: JSON.stringify({
            hostName: validation.hostName,
            line: selectedLine,
          }),
        });
        if (!createDefaultProject) {
          navigate("/hosts", true);
          return;
        }
        const host = await waitForShellHost(validation.hostName, selectedLine);
        const surfaceId = selectedLine === "vertical" ? host.wanghaiId : host.serverId;
        if (!surfaceId) {
          throw new Error("主机仍在准备中，请稍后刷新主机列表");
        }
        navigate(buildCreatedHostSurfaceHref(surfaceId, selectedLine));
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        if (submit) {
          submit.textContent = "创建并启动";
          updateState();
        }
      }
    })();
  });
}

async function waitForShellHost(
  name: string,
  line: "coding" | "vertical",
): Promise<ShellHostSummary> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const payload = await request<{ hosts: ShellHostSummary[] }>(SHELL_HOST_API.listHosts);
    const host = payload.hosts.find((item) => item.name === name);
    if ((line === "vertical" ? host?.wanghaiId : host?.serverId)) {
      return host;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("主机仍在准备中，请稍后刷新主机列表");
}

function bindHostActions(
  card: HTMLElement,
  hosts: ShellHostSummary[],
  session: ShellSession,
): void {
  const name = card.dataset.hostName || "";
  const host = hosts.find((item) => item.name === name);
  if (!host) {
    return;
  }
  for (const button of card.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "open-coding" && button.dataset.href) {
        navigate(button.dataset.href);
        return;
      }
      if (action === "open-wanghai" && button.dataset.href) {
        navigate(button.dataset.href);
        return;
      }
      if (action === "start" || action === "stop") {
        void updateHostAction(button, host.name, action);
        return;
      }
      if (action === "delete") {
        if (!confirm(`删除主机“${host.name}”？此操作不可撤销。`)) {
          return;
        }
        void deleteHost(button, host.name);
      }
    });
  }
  void session;
}

async function updateHostAction(
  button: HTMLButtonElement,
  name: string,
  action: "start" | "stop",
): Promise<void> {
  button.disabled = true;
  try {
    await request(SHELL_HOST_API.hostAction(name), {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await render();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
}

async function deleteHost(button: HTMLButtonElement, name: string): Promise<void> {
  button.disabled = true;
  try {
    await request(SHELL_HOST_API.hostAction(name), { method: "DELETE" });
    navigate("/hosts", true);
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
}

function requireSession(): ShellSession {
  if (!currentSession) {
    throw new Error("登录会话不可用");
  }
  return currentSession;
}

function subscriptionLineLabel(line: ShellSession["line"]): string {
  if (line === "vertical") {
    return "vertical";
  }
  if (line === "both") {
    return "coding / vertical";
  }
  return "coding";
}

function vaultLineLabel(line: PolarisVaultLine): string {
  return line === "vertical" ? "vertical" : "coding";
}

function selectedCreateHostLine(
  lineInputs: HTMLInputElement[],
  allowedLines: readonly PolarisVaultLine[],
): PolarisVaultLine | null {
  for (const lineInput of lineInputs) {
    if (lineInput.checked && allowedLines.includes(lineInput.value as PolarisVaultLine)) {
      return lineInput.value as PolarisVaultLine;
    }
  }
  return allowedLines[0] ?? null;
}

function planLabel(plan: ShellSession["plan"]): string {
  return plan === "pro" ? "pro" : "free";
}

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function fallbackCallbackUrl(): string {
  return `${location.origin}/auth/callback`;
}

async function authingConfig(): Promise<AuthingConfig> {
  return request<AuthingConfig>("/authing-config");
}

async function beginSignIn(prefetchedConfig?: AuthingConfig): Promise<void> {
  const config = prefetchedConfig ?? await authingConfig();
  writeTransientValue(RETURN_PATH_KEY, `${location.pathname}${location.search}`);
  if (config.authMode === "disabled") {
    navigate("/hosts", true);
    return;
  }
  const redirectUri = config.redirectUri || fallbackCallbackUrl();
  writeTransientValue(REDIRECT_URI_KEY, redirectUri);
  if (config.authMode === "oauth2-proxy") {
    const signIn = new URL(config.signInUrl || "/oauth2/start", location.origin);
    signIn.searchParams.set("rd", redirectUri);
    location.assign(signIn.toString());
    return;
  }
  if (!config.appId || !config.authorizationUrl) {
    throw new Error("Authing 配置不完整");
  }
  const verifier = base64Url(randomBytes(32));
  const state = base64Url(randomBytes(24));
  writeTransientValue(PKCE_VERIFIER_KEY, verifier);
  writeTransientValue(PKCE_STATE_KEY, state);
  const authorizationUrl = new URL(config.authorizationUrl);
  const pkce = await createPkceChallenge(verifier);
  authorizationUrl.search = new URLSearchParams({
    client_id: config.appId,
    response_type: "code",
    scope: "openid profile email username phone",
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.value,
    code_challenge_method: pkce.method,
  }).toString();
  location.assign(authorizationUrl.toString());
}

async function completeSignIn(): Promise<string> {
  const config = await authingConfig();
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (config.authMode === "oauth2-proxy" && !code) {
    clearTransientValue(PKCE_VERIFIER_KEY);
    clearTransientValue(PKCE_STATE_KEY);
    clearTransientValue(REDIRECT_URI_KEY);
    return readTransientValue(RETURN_PATH_KEY) || "/hosts";
  }
  const verifier = readTransientValue(PKCE_VERIFIER_KEY);
  const state = readTransientValue(PKCE_STATE_KEY);
  if (!code || !verifier || params.get("state") !== state) {
    throw new Error(AUTHING_LOGIN_ERROR_MESSAGE);
  }
  const result = await request<{ token?: string; idToken?: string }>("/auth/callback", {
    method: "POST",
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      redirectUri: readTransientValue(REDIRECT_URI_KEY) || fallbackCallbackUrl(),
    }),
  });
  if (!result.token?.trim()) {
    throw new Error(AUTHING_LOGIN_ERROR_MESSAGE);
  }
  sessionStorage.setItem(SESSION_TOKEN_KEY, result.token.trim());
  writeCookieValue(SESSION_TOKEN_KEY, result.token.trim());
  if (result.idToken?.trim()) {
    sessionStorage.setItem(ID_TOKEN_KEY, result.idToken.trim());
    writeCookieValue(ID_TOKEN_KEY, result.idToken.trim());
  }
  clearTransientValue(PKCE_VERIFIER_KEY);
  clearTransientValue(PKCE_STATE_KEY);
  clearTransientValue(REDIRECT_URI_KEY);
  const returnPath = readTransientValue(RETURN_PATH_KEY) || "/hosts";
  clearTransientValue(RETURN_PATH_KEY);
  return returnPath;
}

async function ensureCurrentUser(session: ShellSession): Promise<void> {
  const userProfileId = session.authingUsername?.trim();
  if (!userProfileId) {
    throw new Error("Authing 用户信息未补全，请先完成用户名补全");
  }
  await request("/users", {
    method: "POST",
    body: JSON.stringify({
      userProfileId,
      authingUsername: session.authingUsername,
      authingUserId: session.authingUserId,
    }),
  });
}

async function signOut(): Promise<void> {
  const config = await authingConfig().catch(() => null);
  const idToken = sessionStorage.getItem(ID_TOKEN_KEY)?.trim()
    || readCookieValue(ID_TOKEN_KEY)?.trim();
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
  clearCookieValue(SESSION_TOKEN_KEY);
  clearCookieValue(ID_TOKEN_KEY);
  currentSession = null;
  if (config?.authMode === "oauth2-proxy") {
    const url = new URL(config.signOutUrl || "/oauth2/sign_out", location.origin);
    url.searchParams.set("rd", "/welcome");
    location.replace(url.toString());
    return;
  }
  if (config?.logoutUrl) {
    const url = new URL(config.logoutUrl);
    if (idToken) {
      url.searchParams.set("id_token_hint", idToken);
    }
    url.searchParams.set("post_logout_redirect_uri", config.logoutRedirectUri || `${location.origin}/welcome`);
    location.replace(url.toString());
    return;
  }
  navigate("/welcome", true);
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-nav], [data-action]") : null;
  if (!target) {
    return;
  }
  if (target.dataset.nav !== undefined && target instanceof HTMLAnchorElement) {
    event.preventDefault();
    navigate(target.getAttribute("href") || "/hosts");
    return;
  }
  if (target.dataset.action === "sign-in") {
    event.preventDefault();
    void beginSignIn().catch(renderError);
  }
  if (target.dataset.action === "sign-out") {
    event.preventDefault();
    void signOut().catch(renderError);
  }
});

window.addEventListener("popstate", () => {
  void render();
});

void render();
