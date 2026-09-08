import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CliError,
  clickPointsFromLayout,
  commandRun,
  INPUT_SCHEMA,
  validateInput,
  validateOutput,
} from "../runner.mjs";

const INPUT = {
  schema_version: INPUT_SCHEMA,
  run_id: "example-run",
  start_url: "https://example.test/",
  actions: [
    { type: "goto", url: "https://example.test/page" },
    { type: "screenshot", name: "landing" },
  ],
};

test("accepts a bounded browser run", () => {
  assert.equal(validateInput(INPUT), INPUT);
});

test("accepts fixed and humanized pacing options", () => {
  const paced = structuredClone(INPUT);
  paced.browser = { pacing: { delay_ms: 2_000 } };
  assert.equal(validateInput(paced), paced);

  paced.browser = {
    stealth: true,
    humanize: true,
    pacing: { min_delay_ms: 200, max_delay_ms: 800 },
  };
  assert.equal(validateInput(paced), paced);

  paced.browser.pacing.delay_ms = -1;
  assert.throws(() => validateInput(paced), CliError);
});

test("rejects inverted human delay bounds", () => {
  const invalid = structuredClone(INPUT);
  invalid.browser = { pacing: { min_delay_ms: 5_000, max_delay_ms: 100 } };
  assert.throws(() => validateInput(invalid), /min_delay_ms must be <= max_delay_ms/);
});

test("accepts scroll actions", () => {
  const scrolled = structuredClone(INPUT);
  scrolled.actions = [{ type: "scroll", times: 2, delta_y: 400 }];
  assert.equal(validateInput(scrolled), scrolled);
});

test("accepts solve-challenge actions and challenge_click option", () => {
  const challenge = structuredClone(INPUT);
  challenge.browser = {
    wait_for_challenge: true,
    challenge_click: true,
    challenge_timeout_ms: 10_000,
  };
  challenge.actions = [{ type: "solve-challenge", timeout_ms: 5_000 }];
  assert.equal(validateInput(challenge), challenge);
});

test("layout click points prefer captcha left over page center", () => {
  const points = clickPointsFromLayout({
    nodes: [
      {
        selector: ".challenge-captcha",
        className: "challenge-captcha",
        tag: "DIV",
        x: 352,
        y: 509,
        width: 576,
        height: 71,
        cx: 640,
        cy: 545,
      },
      {
        selector: "iframe",
        tag: "IFRAME",
        src: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x",
        x: 490,
        y: 515,
        width: 300,
        height: 65,
        cx: 640,
        cy: 547,
      },
    ],
  });
  assert.ok(points.length >= 2);
  // Checkbox band is left of widget, not the page/widget center.
  assert.ok(points.every((p) => p.x < 640), JSON.stringify(points));
  assert.ok(points.some((p) => p.label.includes("iframe") && p.x < 530));
});

test("clicks a local challenge checkbox via solve-challenge", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const html = `<!doctype html>
<html>
  <head><title>Just a moment...</title></head>
  <body>
    <h1>Security check required</h1>
    <p>Verify you are human</p>
    <div class="cf-turnstile">
      <label class="ctp-checkbox-label">
        <input id="cf-box" type="checkbox" />
        Verify you are human
      </label>
    </div>
    <script>
      document.getElementById('cf-box').addEventListener('change', function () {
        if (this.checked) {
          document.title = 'Challenge cleared';
          document.body.innerHTML = '<h1 id="ok">Welcome</h1>';
        }
      });
    </script>
  </body>
</html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-challenge-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schema_version: INPUT_SCHEMA,
      run_id: "challenge-click-test",
      start_url: `http://127.0.0.1:${port}/`,
      browser: {
        stealth: false,
        humanize: false,
        wait_for_challenge: true,
        challenge_click: true,
        challenge_timeout_ms: 8_000,
        pacing: { delay_ms: 0 },
      },
      actions: [
        { type: "solve-challenge", timeout_ms: 8_000 },
        { type: "extract-text", selector: "h1", name: "heading" },
      ],
    }),
    "utf8",
  );
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    validateOutput(output);
    const solve = output.actions.find((item) => item.type === "solve-challenge");
    assert.ok(solve);
    // Auto-wait on start_url may already clear; solve-challenge should report success path.
    assert.ok(
      output.page.title === "Challenge cleared"
        || output.extractions.some((item) => item.value === "Welcome")
        || solve.challenge?.cleared === true
        || (solve.challenge?.clicks?.length ?? 0) > 0,
      `expected challenge click/clear, got ${JSON.stringify({
        title: output.page.title,
        solve,
        extractions: output.extractions,
      })}`,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("rejects unsupported actions", () => {
  const invalid = structuredClone(INPUT);
  invalid.actions[0] = { type: "download", selector: "a" };

  assert.throws(() => validateInput(invalid), CliError);
});

test("rejects non-HTTP navigation", () => {
  const invalid = structuredClone(INPUT);
  invalid.start_url = "file:///etc/passwd";

  assert.throws(() => validateInput(invalid), CliError);
});

test("runs a declared interaction in local Chromium", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      "<!doctype html><title>Browser test</title><h1>Local browser test</h1><input id='q' />",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-test-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  const input = {
    schema_version: INPUT_SCHEMA,
    run_id: "local-browser-test",
    start_url: `http://127.0.0.1:${port}/`,
    browser: {
      headless: true,
      stealth: true,
      humanize: true,
      timeout_ms: 30_000,
      pacing: { min_delay_ms: 20, max_delay_ms: 40 },
    },
    actions: [
      { type: "wait-for", selector: "h1" },
      { type: "fill", selector: "#q", value: "hello" },
      { type: "scroll", times: 1, delta_y: 120 },
      { type: "extract-text", selector: "h1", name: "heading" },
      { type: "screenshot", name: "local-page" },
    ],
  };
  await writeFile(inputPath, JSON.stringify(input), "utf8");
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    validateOutput(output);
    assert.equal(output.status, "succeeded");
    assert.equal(output.page.title, "Browser test");
    assert.deepEqual(output.extractions, [
      { name: "heading", kind: "text", value: "Local browser test" },
    ]);
    assert.equal(output.artifacts.length, 1);
    assert.match(output.automation_policy.stealth, /stealth/i);
    assert.match(output.automation_policy.humanize, /typing|scroll|mouse/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("runs without stealth or humanize when disabled", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Plain</title><h1>Plain</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-plain-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schema_version: INPUT_SCHEMA,
      run_id: "plain-browser-test",
      start_url: `http://127.0.0.1:${port}/`,
      browser: {
        headless: true,
        stealth: false,
        humanize: false,
        pacing: { delay_ms: 0 },
      },
      actions: [{ type: "extract-text", selector: "h1", name: "heading" }],
    }),
    "utf8",
  );
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.extractions[0].value, "Plain");
    assert.equal(output.automation_policy.stealth, "disabled");
    assert.equal(output.automation_policy.humanize, "disabled");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("extract-html writes artifact and extraction preview", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      '<!doctype html><html><head><title>HTML extract</title></head>'
      + '<body><div class="gs_r"><h3 class="gs_rt">Scholar-like</h3></div></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-html-extract-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schema_version: INPUT_SCHEMA,
      run_id: "html-extract-test",
      start_url: `http://127.0.0.1:${port}/`,
      browser: {
        headless: true,
        stealth: false,
        humanize: false,
        pacing: { delay_ms: 0 },
      },
      actions: [{ type: "extract-html", name: "page" }],
    }),
    "utf8",
  );
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.status, "succeeded");
    const htmlExtraction = output.extractions.find((item) => item.kind === "html");
    assert.ok(htmlExtraction);
    assert.match(htmlExtraction.value, /gs_r/);
    assert.match(htmlExtraction.value, /Scholar-like/);
    const htmlArtifact = output.artifacts.find((item) => item.kind === "html");
    assert.ok(htmlArtifact);
    const onDisk = await readFile(htmlArtifact.path, "utf8");
    assert.match(onDisk, /gs_rt/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("accepts channel and proxy browser options", () => {
  const configured = structuredClone(INPUT);
  configured.browser = {
    channel: "chrome",
    proxy: {
      server: "http://127.0.0.1:8888",
      username: "user",
      password: "pass",
      bypass: "localhost",
    },
  };
  assert.equal(validateInput(configured), configured);
});

test("accepts camofox backend options", () => {
  const configured = structuredClone(INPUT);
  configured.browser = {
    backend: "camofox",
    camofox_url: "http://127.0.0.1:9377",
  };
  assert.equal(validateInput(configured), configured);
  configured.browser.backend = "nope";
  assert.throws(() => validateInput(configured), /backend/);
});

test("does not save HTML challenge pages as PDF downloads", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const html = "<!doctype html><title>Denied</title><h1>Access denied</h1>";
  const server = createServer((_request, response) => {
    response.writeHead(403, {
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Length": String(Buffer.byteLength(html)),
    });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-html-pdf-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schema_version: INPUT_SCHEMA,
      run_id: "html-as-pdf-url-test",
      start_url: `http://127.0.0.1:${port}/paper.pdf`,
      browser: { stealth: false, humanize: false, pacing: { delay_ms: 0 } },
      actions: [{ type: "extract-text", selector: "h1", name: "heading" }],
    }),
    "utf8",
  );
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.extractions[0].value, "Access denied");
    assert.equal(output.artifacts.filter((item) => item.kind === "download").length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("saves PDF response bodies as download artifacts", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="paper.pdf"',
      "Content-Length": String(pdfBytes.length),
    });
    response.end(pdfBytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-pdf-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schema_version: INPUT_SCHEMA,
      run_id: "pdf-browser-test",
      start_url: `http://127.0.0.1:${port}/paper.pdf`,
      browser: { stealth: false, humanize: false, pacing: { delay_ms: 0 } },
      actions: [{ type: "scroll", times: 1, delta_y: 0 }],
    }),
    "utf8",
  );
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    validateOutput(output);
    const downloads = output.artifacts.filter((item) => item.kind === "download");
    assert.ok(downloads.length >= 1, "expected a download artifact for PDF body");
    assert.match(downloads[0].filename, /paper\.pdf|document\.pdf|download/i);
    assert.ok(downloads[0].bytes > 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("continues after an HTTP 403 response page", async (context) => {
  try {
    await import("playwright");
  } catch {
    context.skip("Playwright is not installed");
    return;
  }
  const server = createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Denied</title><h1>Access denied</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const directory = await mkdtemp(join(tmpdir(), "clue-browser-403-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schema_version: INPUT_SCHEMA,
      run_id: "http-403-browser-test",
      start_url: `http://127.0.0.1:${port}/`,
      browser: { stealth: false, humanize: false, pacing: { delay_ms: 0 } },
      actions: [
        { type: "extract-text", selector: "h1", name: "heading" },
        { type: "screenshot", name: "denied" },
      ],
    }),
    "utf8",
  );
  try {
    await commandRun(inputPath, outputPath);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.status, "succeeded");
    assert.equal(output.extractions[0].value, "Access denied");
    assert.equal(output.artifacts.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
