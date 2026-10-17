import assert from "node:assert/strict";
import test from "node:test";
import { runAdapter, splitArgv } from "../src/dispatcher-adapter.js";

function capture(argv: string[], env: NodeJS.ProcessEnv): { exitCode: number; stderr: string } {
  const writes: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return runAdapter(argv, env)
    .then((exitCode) => {
      process.stderr.write = originalWrite;
      return { exitCode, stderr: writes.join("") };
    })
    .catch((error) => {
      process.stderr.write = originalWrite;
      throw error;
    });
}

test("dispatcher adapter splits bwrap profile args from the wrapped command", () => {
  assert.deepEqual(
    splitArgv(["--ro-bind", "/a", "/a", "--", "bash", "-c", "echo"]),
    { profileArgs: ["--ro-bind", "/a", "/a"], command: ["bash", "-c", "echo"] },
  );
  assert.deepEqual(splitArgv(["bash", "-c", "echo"]), { profileArgs: [], command: ["bash", "-c", "echo"] });
});

test("dispatcher adapter fails closed without a dispatcher URL", async () => {
  const result = await capture(["bash", "-c", "echo"], {});
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /CLH_DISPATCHER_URL_MISSING/u);
});

test("dispatcher adapter fails closed without a wrapped command", async () => {
  const result = await capture(["--ro-bind", "/a", "/a", "--"], {
    POLARIS_CLH_DISPATCHER_URL: "http://127.0.0.1:9/exec",
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no wrapped command/u);
});

test("dispatcher adapter forwards to the dispatcher endpoint and relays the exit code", async () => {
  const { createServer } = await import("node:http");
  const { AddressInfo } = await import("node:net");
  let received: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      received = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ exitCode: 3, stdout: "out", stderr: "err" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const result = await capture(["--ro-bind", "/a", "/a", "--", "bash", "-c", "echo"], {
      POLARIS_CLH_DISPATCHER_URL: `http://127.0.0.1:${address.port}/exec`,
    });
    assert.equal(result.exitCode, 3);
    assert.deepEqual(received, {
      profileArgs: ["--ro-bind", "/a", "/a"],
      command: ["bash", "-c", "echo"],
      cwd: process.cwd(),
    });
  } finally {
    server.close();
  }
});
