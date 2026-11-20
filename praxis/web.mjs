import { normalizeRuntimeRun } from './runtime-traces.mjs';
function route({method,pathname}) {
  const decoded=decodeURIComponent(pathname);
  if(!['GET','HEAD'].includes(method)||decoded==='/g'||decoded.startsWith('/g/')||decoded==='/api/praxis/traces'||decoded.startsWith('/api/praxis/traces/'))return {deny:404,checks:[]};
  return {binding:'native',checks:[]};
}

export function createWebIntegration() {
  return {
    "slug": "polaris",
    "policy": "platform-admin",
    "kind": "proxy",
    "allowUpgrade": false,
    "nativePort": 18787,
    "readOnly": true,
    runtimeTrace: {path:"/api/praxis/traces",normalizeRun:normalizeRuntimeRun},
    "forwardHeaders": [
      "accept",
      "accept-encoding",
      "accept-language",
      "content-type",
      "content-length",
      "origin",
      "range",
      "if-range",
      "if-none-match",
      "if-modified-since",
      "last-event-id",
      "idempotency-key",
      "x-polaris-expected-version"
    ],
    "hostMode": "target",
    "rewriteOrigin": true,
    "internalPaths": [
      "/api/praxis/traces"
    ],
    route
  };
}
