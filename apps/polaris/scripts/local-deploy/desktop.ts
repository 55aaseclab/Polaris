import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { LOCAL_DEPLOY_ACTIONS, type LocalDeployAction } from "./types.js";
import { runLocalDeployAction } from "./control.js";

const DESKTOP_ACTIONS = LOCAL_DEPLOY_ACTIONS.filter(
  (action): action is Exclude<LocalDeployAction, "desktop"> => action !== "desktop",
);

function isDesktopAction(value: string): value is Exclude<LocalDeployAction, "desktop"> {
  return DESKTOP_ACTIONS.includes(value as Exclude<LocalDeployAction, "desktop">);
}

function htmlPage(status: string): string {
  const buttons = DESKTOP_ACTIONS.map((action) =>
    `<button data-action="${action}" type="button">${action}</button>`
  ).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Polaris Desktop Launcher</title>
    <style>
      body { font-family: sans-serif; margin: 0; background: #f5f7fb; color: #0f172a; }
      main { max-width: 720px; margin: 0 auto; padding: 32px 20px 56px; }
      h1 { font-size: 28px; margin: 0 0 12px; }
      p { line-height: 1.5; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 24px 0; }
      button { border: 0; border-radius: 12px; padding: 14px 16px; background: #0f172a; color: #fff; font-size: 15px; cursor: pointer; }
      button:hover { background: #1e293b; }
      pre { background: #fff; border: 1px solid #dbe1ea; border-radius: 12px; padding: 16px; white-space: pre-wrap; word-break: break-word; min-height: 160px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Polaris Desktop Launcher</h1>
      <p>This desktop launcher uses the same one-shot local deployment actions as the CLI.</p>
      <div class="grid">${buttons}</div>
      <pre id="status">${status}</pre>
    </main>
    <script>
      const status = document.getElementById("status");
      async function run(action) {
        status.textContent = "Running " + action + "...";
        const response = await fetch("/actions/" + action, { method: "POST" });
        const payload = await response.json();
        status.textContent = payload.ok ? payload.message + "\\n" + (payload.details || []).join("\\n") : payload.error;
      }
      for (const button of document.querySelectorAll("button[data-action]")) {
        button.addEventListener("click", () => run(button.dataset.action));
      }
    </script>
  </body>
</html>`;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function startLocalDeployGui(
  importMetaUrl: string,
  port = 0,
): Promise<{ url: string }> {
  const initial = await runLocalDeployAction("doctor", importMetaUrl).catch((error) => ({
    message: error instanceof Error ? error.message : String(error),
    details: [],
  }));
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && requestUrl.pathname === "/") {
      const details = "details" in initial && Array.isArray(initial.details)
        ? [initial.message, ...initial.details].filter(Boolean).join("\n")
        : initial.message;
      sendHtml(res, htmlPage(details));
      return;
    }
    if (req.method === "POST" && requestUrl.pathname.startsWith("/actions/")) {
      const action = requestUrl.pathname.slice("/actions/".length);
      if (!isDesktopAction(action)) {
        sendJson(res, 404, { ok: false, error: "Unknown action" });
        return;
      }
      try {
        const result = await runLocalDeployAction(action, importMetaUrl);
        sendJson(res, 200, { ok: true, message: result.message, details: result.details ?? [] });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to start local deploy GUI");
  }
  return { url: `http://127.0.0.1:${address.port}` };
}
