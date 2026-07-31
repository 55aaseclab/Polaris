import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "8090", 10);
const host = "0.0.0.0";
const publicRoot = resolve(import.meta.dirname, "public");
const embedBundle = resolve(import.meta.dirname, "../../packages/paseo-embed/dist/index.js");
const defaultWorkspacePath =
  process.env.PASEO_EMBED_DEFAULT_WORKSPACE?.trim() || resolve(import.meta.dirname, "../..");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function resolveAsset(pathname) {
  if (pathname === "/vendor/paseo-embed.js") {
    return embedBundle;
  }
  const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const filePath = resolve(publicRoot, `.${normalize(decoded)}`);
  return filePath.startsWith(`${publicRoot}/`) || filePath === publicRoot ? filePath : null;
}

createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/config.json") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ workspacePath: defaultWorkspacePath }));
    return;
  }

  const filePath = resolveAsset(requestUrl.pathname);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}).listen(port, host, () => {
  console.log(`Paseo embed demo listening on ${host}:${port}`);
});
