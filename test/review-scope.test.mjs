import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REVIEW_POLICY_PREFIX,
  routeReview,
} from "../lib/review-route.js";
import {
  allowDecisionStream,
  classifyToolCall,
  isConfigFile,
  isInsideProject,
  isMcpTool,
  readReviewInput,
  resolveScopePath,
  reviewScopeDecision,
} from "../lib/review-scope.js";

/** A project directory that exists on disk, so real paths resolve. */
function makeProject(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scope-")),
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function textMessage(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function pendingCall(name, args, { raw = false, mode = "native" } = {}) {
  return {
    kind: "tool-call",
    role: "fact",
    mode,
    name,
    arguments: raw ? args : JSON.stringify(args),
  };
}

/** Build a request shaped like auto review's `classifyRisk` output. */
function reviewRequest(cwd, name, args, options = {}) {
  return {
    provider: "reviewer",
    model: "reviewer-1",
    system: `${REVIEW_POLICY_PREFIX}You are the Auto review policy.`,
    temperature: 0,
    sessionId: "session-1",
    purpose: "auto-review",
    messages: [
      textMessage(`ENVIRONMENT\n${JSON.stringify({ cwd }, null, 2)}`),
      textMessage(
        JSON.stringify(
          {
            kind: "tool-schema",
            role: "fact",
            mode: "native",
            name,
            description: "test schema",
            parameters: { type: "object" },
          },
          null,
          2,
        ),
      ),
      textMessage(JSON.stringify(pendingCall(name, args, options), null, 2)),
    ],
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("readReviewInput reads cwd and the pending native call", () => {
  const request = reviewRequest("C:\\project", "read", {
    file_path: "src/index.ts",
  });
  const input = readReviewInput(request);
  assert.equal(input?.cwd, "C:\\project");
  assert.equal(input?.name, "read");
  assert.deepEqual(input?.arguments, { file_path: "src/index.ts" });
  assert.equal(input?.mode, "native");
});

test("readReviewInput accepts arguments as an object and skips history", () => {
  const call = pendingCall("pwsh", { command: "npm test" }, { raw: true });
  const request = reviewRequest("C:\\project", "pwsh", { command: "npm test" });
  request.messages.splice(
    1,
    0,
    textMessage(JSON.stringify({ kind: "user-message", role: "user" })),
  );
  // The native adapter usually sends a JSON string, but a PTC-style object
  // must parse too.
  request.messages[3] = textMessage(JSON.stringify(call, null, 2));
  const input = readReviewInput(request);
  assert.equal(input?.name, "pwsh");
  assert.deepEqual(input?.arguments, { command: "npm test" });
});

test("readReviewInput returns undefined for anything it cannot parse", () => {
  assert.equal(readReviewInput(undefined), undefined);
  assert.equal(readReviewInput({}), undefined);

  const short = reviewRequest("C:\\project", "read", { file_path: "a" });
  short.messages = [short.messages[0]];
  assert.equal(readReviewInput(short), undefined);

  const badEnvironment = reviewRequest("C:\\project", "read", { file_path: "a" });
  badEnvironment.messages[0] = textMessage("not an environment");
  assert.equal(readReviewInput(badEnvironment), undefined);

  const badPending = reviewRequest("C:\\project", "read", { file_path: "a" });
  badPending.messages[2] = textMessage("{not json");
  assert.equal(readReviewInput(badPending), undefined);

  const wrongKind = reviewRequest("C:\\project", "read", { file_path: "a" });
  wrongKind.messages[2] = textMessage(JSON.stringify({ kind: "tool-schema" }));
  assert.equal(readReviewInput(wrongKind), undefined);

  const badArguments = reviewRequest("C:\\project", "read", "{oops", {
    raw: true,
  });
  assert.equal(readReviewInput(badArguments), undefined);
});

test("resolveScopePath handles relative, absolute, home and missing paths", (t) => {
  const root = makeProject(t);
  assert.equal(
    path.dirname(resolveScopePath(root, "src/index.ts")),
    path.join(root, "src"),
  );
  assert.equal(
    resolveScopePath(root, path.join(root, "src", "index.ts")),
    path.join(root, "src", "index.ts"),
  );
  assert.equal(
    resolveScopePath(root, "~/dsh-scope-home-check"),
    path.join(os.homedir(), "dsh-scope-home-check"),
  );
  assert.equal(
    resolveScopePath(root, "new-dir/new-file.ts"),
    path.join(root, "new-dir", "new-file.ts"),
  );
});

test("isInsideProject respects the root and sibling prefixes", (t) => {
  const root = makeProject(t);
  const file = path.join(root, "src", "index.ts");
  assert.equal(isInsideProject(root, file), true);
  assert.equal(isInsideProject(root, root), true);
  assert.equal(isInsideProject(root, path.dirname(root)), false);
  assert.equal(isInsideProject(root, path.join(root, "..", "outside.txt")), false);
  assert.equal(
    isInsideProject(root, path.join(path.dirname(root), `${path.basename(root)}-x`, "a")),
    false,
  );
});

test("isInsideProject sees through a link that points outside the project", (t) => {
  const root = makeProject(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scope-out-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(root, "link-out");
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("symlinks are not available on this platform");
    return;
  }
  t.after(() => {
    try {
      fs.unlinkSync(link);
    } catch {
      // Already gone, or a directory link that needs rmdir.
    }
    try {
      fs.rmdirSync(link);
    } catch {
      // Already gone.
    }
  });
  const target = resolveScopePath(root, path.join("link-out", "secret.txt"));
  assert.equal(isInsideProject(root, target), false);
});

test("isConfigFile covers dotenv, manifests, tool config and CI", (t) => {
  const root = makeProject(t);
  const config = (relative) => isConfigFile(root, resolveScopePath(root, relative));
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "config.json",
    "config.local.json",
    "src/config.ts",
    "settings.json",
    "settings.local.yaml",
    "appsettings.Development.json",
    "application-prod.yml",
    "nginx.conf",
    "Makefile",
    ".gitignore",
    ".dockerignore",
    "data/config.json",
    "vite.config.ts",
    "jest.config.js",
    "src/app.config.ts",
    "Dockerfile",
    "docker-compose.yml",
    "cordis.patch.yml",
    "pyproject.toml",
    ".github/workflows/ci.yml",
    ".git/hooks/pre-commit",
    ".vscode/settings.json",
  ]) {
    assert.equal(config(name), true, `${name} should be configuration`);
  }
  for (const name of [
    "src/index.ts",
    "src/data.json",
    "docs/guide.md",
    "src/notes.yaml",
    "src/configurable.ts",
    "docs/config.md",
    "test/review-scope.test.mjs",
  ]) {
    assert.equal(config(name), false, `${name} should not be configuration`);
  }

  if (process.platform === "win32") {
    // Win32 strips trailing dots and spaces, so these overwrite the config file.
    assert.equal(config("package.json."), true);
    assert.equal(config(".env "), true);
  }
});

test("classifyToolCall reviews only the sensitive categories", (t) => {
  const root = makeProject(t);
  const call = (name, args) => classifyToolCall({ cwd: root, name, arguments: args });

  assert.equal(call("read", { file_path: "src/index.ts" }).review, false);
  assert.equal(call("read", { file_path: "src/index.ts" }).reason, "project-read");
  assert.equal(call("read", { file_path: path.join(root, "src", "index.ts") }).review, false);
  // Forward slashes are separators on every platform; backslashes only on
  // Windows (POSIX treats them as filename characters, see the guarded block
  // further down), so portable assertions must use forward slashes.
  assert.equal(call("read", { file_path: "../outside.txt" }).review, true);
  assert.equal(call("read", { file_path: "../outside.txt" }).reason, "external-read");
  assert.equal(call("read", {}).review, true);
  assert.equal(call("read_image", { file_path: "../outside.png" }).review, true);

  assert.equal(call("grep", { pattern: "x" }).review, false);
  assert.equal(call("glob", { pattern: "**/*.ts", path: "src" }).review, false);
  assert.equal(call("glob", { pattern: "**/*.ts", path: ".." }).review, true);
  assert.equal(call("glob", { pattern: "../**/*.ts" }).review, true);
  assert.equal(call("glob", { pattern: "!../**/*.ts" }).review, true);
  assert.equal(call("glob", { pattern: "/etc/**" }).review, true);
  assert.equal(call("glob", { pattern: "\\\\server\\share\\**" }).review, true);
  assert.equal(call("grep", { pattern: "x", include: "/etc/*.ts" }).review, true);
  assert.equal(call("glob", { pattern: "{../outside,src}/**" }).review, true);
  assert.equal(call("grep", { pattern: "x", include: "../*.ts" }).review, true);
  assert.equal(call("grep", { pattern: "x", include: "*.ts" }).review, false);
  assert.equal(call("glob", { pattern: path.join(root, "..", "**", "*.ts") }).review, true);
  assert.equal(call("grep", { pattern: "x", path: path.join(root, "..") }).review, true);

  assert.equal(call("write", { file_path: "src/new.ts", content: "" }).review, false);
  assert.equal(call("edit", { file_path: "src/index.ts" }).review, false);
  assert.equal(call("write", { file_path: "src/new.ts" }).reason, "project-write");
  assert.equal(call("write", { file_path: ".env", content: "" }).review, true);
  assert.equal(call("write", { file_path: ".env", content: "" }).reason, "config-write");
  assert.equal(call("write", { file_path: "package.json" }).review, true);
  assert.equal(call("write", { file_path: "../outside.txt" }).review, true);
  assert.equal(call("write", { file_path: "../outside.txt" }).reason, "external-write");
  assert.equal(call("write", {}).review, true);
  assert.equal(call("apply_patch", { patch: "*** Begin Patch" }).review, true);

  if (process.platform === "win32") {
    // Backslash-separated relative paths only escape the project on Windows;
    // on POSIX `..\outside.txt` is one filename inside the project.
    assert.equal(call("read", { file_path: "..\\outside.txt" }).review, true);
    assert.equal(call("read_image", { file_path: "..\\outside.png" }).review, true);
    assert.equal(call("write", { file_path: "..\\outside.txt" }).review, true);
    assert.equal(call("write", { file_path: "..\\outside.txt" }).reason, "external-write");
  }

  for (const name of ["plugin_manager", "create_worktree", "qqbot_send_file"]) {
    assert.equal(call(name, {}).review, true, name);
    assert.equal(call(name, {}).reason, "sensitive-tool");
    assert.equal(classifyToolCall({ cwd: root, name, arguments: {} }, { reviewMcp: false, reviewInternet: false }).review, true, name);
  }

  for (const shell of ["pwsh", "powershell", "bash", "sh", "zsh", "run_command"]) {
    assert.equal(call(shell, { command: "npm test" }).review, true, shell);
  }

  assert.equal(call("mcp__github__search", {}).review, true);
  assert.equal(call("read_mcp_resource", {}).review, true);
  assert.equal(
    classifyToolCall(
      { cwd: root, name: "mcp__github__search", arguments: {} },
      { reviewMcp: false },
    ).review,
    false,
  );

  assert.equal(call("web_fetch", { url: "https://example.com" }).review, true);
  assert.equal(call("web_search", { queries: ["x"] }).review, true);
  assert.equal(
    classifyToolCall(
      { cwd: root, name: "web_fetch", arguments: { url: "https://example.com" } },
      { reviewInternet: false },
    ).review,
    false,
  );

  assert.equal(call("weather", { location: "Beijing" }).review, true);
  assert.equal(call("read_resource", {}).review, false);
  assert.equal(call("unknown_tool", {}).reason, "other-tool");
});

test("isMcpTool matches the tool prefix and resource tools", () => {
  assert.equal(isMcpTool("mcp__cloudflare__docs"), true);
  assert.equal(isMcpTool("read_mcp_resource"), true);
  assert.equal(isMcpTool("list_mcp_resources"), true);
  assert.equal(isMcpTool("mcp"), false);
  assert.equal(isMcpTool("read"), false);
});

test("reviewScopeDecision defaults to sensitive and fails closed", (t) => {
  const root = makeProject(t);
  const projectRead = reviewRequest(root, "read", { file_path: "src/index.ts" });
  assert.equal(reviewScopeDecision(projectRead, {}).review, false);
  assert.equal(reviewScopeDecision(projectRead, { scope: "SENSITIVE" }).review, false);

  const shell = reviewRequest(root, "pwsh", { command: "npm test" });
  assert.equal(reviewScopeDecision(shell, {}).review, true);
  assert.equal(reviewScopeDecision(shell, { scope: "all" }).review, true);
  assert.equal(reviewScopeDecision(shell, { scope: "all" }).reason, "scope-all");

  assert.equal(reviewScopeDecision({}, {}).review, true);
  assert.equal(reviewScopeDecision({}, {}).reason, "unparseable");
});

test("allowDecisionStream is exactly what readDecision accepts", async () => {
  const events = await collect(allowDecisionStream());
  assert.deepEqual(events, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: '{"risk":"low","decision":"allow"}' },
    {
      type: "block-end",
      index: 0,
      block: { type: "text", text: '{"risk":"low","decision":"allow"}' },
    },
    { type: "finish", reason: { kind: "stop" } },
  ]);
});

test("routeReview skips the reviewer when scope returns false", async () => {
  const request = reviewRequest("C:\\project", "read", { file_path: "src/index.ts" });
  let dispatched = 0;
  let seen;
  const result = routeReview(
    request,
    {
      provider: "reviewer",
      model: "reviewer-1",
      scope: (options) => {
        seen = options;
        return false;
      },
    },
    () => {
      dispatched += 1;
      return { type: "dispatched" };
    },
  );
  assert.equal(seen, request);
  assert.equal(dispatched, 0);
  const events = await collect(result);
  assert.equal(events.at(-1)?.type, "finish");
  assert.equal(events.at(-1)?.reason.kind, "stop");
});

test("routeReview reviews when scope is missing, true or throws", () => {
  const request = reviewRequest("C:\\project", "pwsh", { command: "npm test" });
  const sentinel = { type: "dispatched" };

  assert.equal(
    routeReview(
      request,
      { provider: "reviewer", model: "reviewer-1" },
      () => sentinel,
    ),
    sentinel,
  );

  let calls = 0;
  const result = routeReview(
    request,
    {
      provider: "reviewer",
      model: "reviewer-1",
      scope: () => {
        calls += 1;
        return true;
      },
    },
    () => sentinel,
  );
  assert.equal(result, sentinel);
  assert.equal(calls, 1);

  assert.equal(
    routeReview(
      request,
      {
        provider: "reviewer",
        model: "reviewer-1",
        scope: () => {
          throw new Error("scope bug");
        },
      },
      () => sentinel,
    ),
    sentinel,
  );
});

test("routeReview never asks scope about a non-review request", () => {
  let calls = 0;
  const result = routeReview(
    { system: "You are a helpful assistant.", messages: [] },
    {
      provider: "reviewer",
      model: "reviewer-1",
      scope: () => {
        calls += 1;
        return false;
      },
    },
    () => ({ type: "dispatched" }),
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});
