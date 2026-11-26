/**
 * Deterministic review scope.
 *
 * The shipped auto-review plugin sends one review request per pending tool
 * call. The first message of that request is the session environment, and the
 * last one is the pending call:
 *
 *   ENVIRONMENT\n{"cwd":"C:\\project"}
 *   {"kind":"tool-call","role":"fact","mode":"native","name":"read","arguments":"{\"file_path\":\"src/index.ts\"}"}
 *
 * This module reads exactly those two messages and decides whether the call is
 * worth a reviewer request. Everything else (the policy prompt, the history)
 * is irrelevant here.
 *
 * The decision is fail-closed: a request that cannot be parsed is reviewed.
 * Tools outside the listed categories are not reviewed, which is the point of
 * a scope filter; `scope: "all"` restores the shipped behaviour.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Review only the sensitive categories (the default). */
export const SCOPE_SENSITIVE = "sensitive";

/** Review every tool call, the behaviour before this setting existed. */
export const SCOPE_ALL = "all";

/**
 * Command execution. `run_code` is included because code-mode inner calls can
 * do the same I/O as a shell; the auto-review plugin already skips the root
 * `run_code` call itself.
 */
const SHELL_TOOLS = new Set([
  "pwsh",
  "powershell",
  "bash",
  "sh",
  "zsh",
  "shell",
  "terminal",
  "run_command",
  "run_code",
]);

/** Tools that only read a path (or default to the session cwd). */
const READ_TOOLS = new Set([
  "read",
  "read_image",
  "grep",
  "glob",
  "list_directory",
  "list_dir",
  "ls",
]);

/** Tools that write a single path. `apply_patch` is handled fail-closed. */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

/**
 * Tools whose effect is outside the project or visible to other people even
 * though their arguments do not carry a single reviewable path. Installing a
 * plugin can run build scripts; a worktree is created outside the workspace;
 * sending a file is egress.
 */
const ALWAYS_REVIEW_TOOLS = new Set([
  "plugin_manager",
  "create_worktree",
  "qqbot_send_file",
]);

/** Tools that reach the Internet. Controlled by `reviewInternet`. */
const INTERNET_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "research",
  "multi_search",
  "advanced_search",
  "platform_search",
  "video_search",
  "domain_search",
  "free_search_test",
  "weather",
]);

/** MCP resource reads do not use the `mcp__` prefix. */
const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/**
 * File names that are configuration even when they are not at the project root
 * or do not follow a `*.config.*` pattern. Compared case-insensitively.
 */
const CONFIG_BASENAMES = new Set([
  // Secrets and environment.
  ".envrc",
  // Repository and editor configuration.
  ".editorconfig",
  ".gitattributes",
  ".gitmodules",
  ".gitconfig",
  ".gitignore",
  ".dockerignore",
  ".npmignore",
  ".prettierignore",
  ".eslintignore",
  ".browserslistrc",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  // JavaScript / TypeScript.
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "rush.json",
  "workspace.json",
  "angular.json",
  "project.json",
  "tsconfig.json",
  "jsconfig.json",
  "config.json",
  "config.yaml",
  "config.yml",
  "config.toml",
  "config.js",
  "config.cjs",
  "config.mjs",
  "config.ts",
  "config.cts",
  "config.mts",
  "settings.json",
  "settings.yaml",
  "settings.yml",
  "settings.toml",
  "appsettings.json",
  "application.properties",
  "application.yml",
  "application.yaml",
  "nginx.conf",
  "caddyfile",
  "procfile",
  "makefile",
  "cmakelists.txt",
  "biome.json",
  "biome.jsonc",
  "deno.json",
  "deno.jsonc",
  // Python.
  "pyproject.toml",
  "poetry.lock",
  "pipfile",
  "pipfile.lock",
  "tox.ini",
  "uv.lock",
  "pdm.lock",
  "setup.cfg",
  // Rust.
  "cargo.toml",
  "cargo.lock",
  "rust-toolchain.toml",
  "rust-toolchain",
  // Go.
  "go.mod",
  "go.sum",
  // PHP / Ruby.
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  // JVM.
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  // Swift / Dart / Elixir / Erlang / Haskell.
  "package.swift",
  "package.resolved",
  "pubspec.yaml",
  "pubspec.lock",
  "mix.exs",
  "mix.lock",
  "rebar.config",
  "rebar.lock",
  "stack.yaml",
  "cabal.project",
  // Containers and deployment.
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "electron-builder.yml",
  "electron-builder.yaml",
  "vercel.json",
  "netlify.toml",
  "firebase.json",
  "renovate.json",
  "now.json",
  "wrangler.toml",
  "fly.toml",
  "mise.toml",
  ".mise.toml",
  ".tool-versions",
  "devcontainer.json",
  // CI.
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "appveyor.yml",
  "bitbucket-pipelines.yml",
  "jenkinsfile",
]);

/** Configuration names that carry a version, environment or tool suffix. */
const CONFIG_BASENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^.+\.env$/i,
  /^tsconfig\..+\.json$/i,
  /^jsconfig\..+\.json$/i,
  /^config(?:\.[^.]+)*\.(?:json|ya?ml|toml|[cm]?[jt]s)$/i,
  /^settings(?:\.[^.]+)*\.(?:json|ya?ml|toml)$/i,
  /^appsettings(?:\.[^.]+)*\.json$/i,
  /^application(?:[-.].+)?\.(?:ya?ml|properties)$/i,
  /^requirements(?:[-_.].+)?\.txt$/i,
  /^dockerfile(?:\..+)?$/i,
  /^docker-compose.*\.ya?ml$/i,
  /^compose.*\.ya?ml$/i,
  /^webpack\..+\.(?:[cm]?[jt]s)$/i,
  /^vitest\.workspace\.(?:[cm]?[jt]s)$/i,
  /^.+\.config\.(?:[cm]?[jt]s|[jt]sx|json|ya?ml|toml)$/i,
  /^\.(?:eslintrc|prettierrc|stylelintrc|babelrc|swcrc|commitlintrc|lintstagedrc|markdownlintrc|oxlintrc)(?:\..+)?$/i,
];

/** Configuration kept in a well-known subdirectory. */
const CONFIG_PATH_PATTERNS = [
  /(?:^|\/)\.git\/config$/i,
  /(?:^|\/)\.git\/hooks\/[^/]+$/i,
  /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i,
  /(?:^|\/)\.github\/actions\/.+\/action\.ya?ml$/i,
  /(?:^|\/)\.github\/dependabot\.ya?ml$/i,
  /(?:^|\/)\.vscode\/[^/]+\.json$/i,
  /(?:^|\/)\.devcontainer\/[^/]+\.json$/i,
  /(?:^|\/)\.circleci\/config\.ya?ml$/i,
  /(?:^|\/)\.gitlab\/[^/]+\.ya?ml$/i,
];

/**
 * Win32 strips trailing dots and spaces from path segments, so `package.json.`
 * writes `package.json`. Compare the name the filesystem will actually use.
 * @param {string} unix - project-relative path with `/` separators.
 * @returns {string}
 */
function configComparisonPath(unix) {
  if (process.platform !== "win32") return unix;
  return unix
    .split("/")
    .map((segment) => {
      const trimmed = segment.replace(/[. ]+$/, "");
      return trimmed === "" ? segment : trimmed;
    })
    .join("/");
}

/**
 * Read one message's text. Auto review uses a single text block per message,
 * but concatenating several blocks is harmless and tolerates adapter changes.
 * @param {{ content?: unknown }} message
 * @returns {string | undefined}
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  let found = false;
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      text += block.text;
      found = true;
    }
  }
  return found ? text : undefined;
}

/**
 * Parse the first review message (`ENVIRONMENT\n{"cwd":...}`).
 * @param {{ content?: unknown }} message
 * @returns {string | undefined}
 */
function readEnvironment(message) {
  const text = messageText(message);
  const prefix = "ENVIRONMENT\n";
  if (text === undefined || !text.startsWith(prefix)) return undefined;
  try {
    const value = JSON.parse(text.slice(prefix.length));
    return typeof value?.cwd === "string" && value.cwd.trim() !== ""
      ? value.cwd
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the pending tool call (the last review message).
 * @param {{ content?: unknown }} message
 * @returns {{ name: string, arguments: Record<string, unknown>, mode?: string } | undefined}
 */
function readPendingCall(message) {
  const text = messageText(message);
  if (text === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    value.kind !== "tool-call" ||
    typeof value.name !== "string" ||
    value.name === ""
  ) {
    return undefined;
  }
  let args = value.arguments;
  if (typeof args === "string") {
    if (args.trim() === "") {
      args = {};
    } else {
      try {
        args = JSON.parse(args);
      } catch {
        return undefined;
      }
    }
  }
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return undefined;
  return { name: value.name, arguments: args, mode: value.mode };
}

/**
 * Extract the cwd and the pending call from one Auto review request.
 *
 * Returns `undefined` for anything that does not look like a review request,
 * which makes the caller review it (fail-closed).
 *
 * @param {{ messages?: unknown }} options
 * @returns {{ cwd: string, name: string, arguments: Record<string, unknown>, mode?: string } | undefined}
 */
export function readReviewInput(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  if (messages.length < 2) return undefined;
  const cwd = readEnvironment(messages[0]);
  if (cwd === undefined) return undefined;
  const pending = readPendingCall(messages[messages.length - 1]);
  if (pending === undefined) return undefined;
  return { cwd, ...pending };
}

/**
 * Resolve a model-supplied path the same way the tool does: relative to the
 * session cwd, with a leading `~` expanded to the home directory.
 *
 * The result is a real path (symlinks resolved) so a link inside the project
 * cannot hide a target outside it. A path that does not exist yet is resolved
 * through its nearest existing ancestor.
 *
 * @param {string} cwd
 * @param {string} requested
 * @returns {string}
 */
export function resolveScopePath(cwd, requested) {
  let value = String(requested).trim();
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(value === "~" ? 1 : 2));
  }
  const absolute = path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(cwd, value);
  return realPath(absolute);
}

/**
 * Resolve symlinks through the nearest existing ancestor.
 * @param {string} absolute
 * @returns {string}
 */
function realPath(absolute) {
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(realPath(parent), path.basename(absolute));
  }
}

/**
 * Whether a resolved path is inside the project root (the review request's
 * cwd). The root itself counts as inside.
 * @param {string} cwd
 * @param {string} target - a path returned by {@link resolveScopePath}.
 * @returns {boolean}
 */
export function isInsideProject(cwd, target) {
  const root = realPath(path.resolve(cwd));
  const relative = path.relative(root, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * Whether a path is a configuration file worth reviewing before a write.
 *
 * The rule is deliberately explicit rather than "any .json/.yaml": reviewing
 * every data file would undo the point of the scope filter. It covers dotenv
 * files, manifests and lockfiles, `*.config.*` and tool rc files, CI
 * definitions, editor/container configuration, and YAML/TOML at the project
 * root (where tools keep their unnamed configuration).
 *
 * @param {string} cwd - project root.
 * @param {string} target - a path returned by {@link resolveScopePath}.
 * @returns {boolean}
 */
export function isConfigFile(cwd, target) {
  const relative = path.relative(realPath(path.resolve(cwd)), target);
  if (relative === "" || path.isAbsolute(relative)) return false;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const unix = configComparisonPath(relative.split(path.sep).join("/"));
  const base = path.posix.basename(unix);
  if (CONFIG_BASENAMES.has(base.toLowerCase())) return true;
  if (CONFIG_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) return true;
  if (CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(unix))) return true;
  // Root-level YAML/TOML is configuration in practice (cordis.patch.yml,
  // docker-compose.yml, netlify.toml, ...); nested data files are not.
  return !unix.includes("/") && /\.(?:ya?ml|toml)$/i.test(unix);
}

/**
 * Whether a glob expression can escape the directory it is resolved against.
 * `glob` patterns and `grep` include filters accept their own path syntax, so
 * the path argument alone is not enough to prove the call stays in the project.
 * @param {unknown} value
 * @returns {boolean}
 */
function globEscapesRoot(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const text = value.trim().replace(/^[!+]+/, "");
  if (text.startsWith("~") || path.isAbsolute(text)) return true;
  // On Windows a leading `\` or `/` is drive-rooted even though `path.isAbsolute`
  // says otherwise; on POSIX a leading `\` is still safer to review.
  if (/^[\\/]/.test(text)) return true;
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(text)) return true;
  // Covers `../x`, `**/../x`, brace alternation such as `{../x,src}/**`, and
  // any other position where a parent segment can appear.
  return text.includes("..");
}

/**
 * Whether a tool name is an MCP tool.
 * @param {string} name
 * @returns {boolean}
 */
export function isMcpTool(name) {
  return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}

/**
 * The path argument for a read tool, or `undefined` when the tool defaults to
 * the session cwd.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {{ value?: string, required: boolean }}
 */
function readPathArgument(name, args) {
  const required = name === "read" || name === "read_image";
  const value = required ? args.file_path : args.path;
  if (value === undefined) return { required };
  if (typeof value !== "string" || value.trim() === "") {
    return { required: true };
  }
  return { value, required };
}

/**
 * Classify a pending tool call against the configured scope.
 * @param {{ cwd: string, name: string, arguments: Record<string, unknown> }} call
 * @param {{ reviewInternet?: boolean, reviewMcp?: boolean }} [settings]
 * @returns {{ review: boolean, reason: string }}
 */
export function classifyToolCall(call, settings = {}) {
  const name = String(call.name ?? "");
  const args = call.arguments ?? {};

  if (SHELL_TOOLS.has(name)) return { review: true, reason: "shell" };

  if (ALWAYS_REVIEW_TOOLS.has(name)) {
    return { review: true, reason: "sensitive-tool" };
  }

  if (isMcpTool(name)) {
    return settings.reviewMcp === false
      ? { review: false, reason: "mcp-off" }
      : { review: true, reason: "mcp" };
  }

  if (INTERNET_TOOLS.has(name)) {
    return settings.reviewInternet === false
      ? { review: false, reason: "internet-off" }
      : { review: true, reason: "internet" };
  }

  if (READ_TOOLS.has(name)) {
    if (name === "glob" || name === "grep") {
      const expression = name === "glob" ? args.pattern : args.include;
      if (globEscapesRoot(expression)) {
        return { review: true, reason: "glob-escape" };
      }
    }
    const { value, required } = readPathArgument(name, args);
    if (value === undefined) {
      return required
        ? { review: true, reason: "missing-path" }
        : { review: false, reason: "project-read" };
    }
    const target = resolveScopePath(call.cwd, value);
    return isInsideProject(call.cwd, target)
      ? { review: false, reason: "project-read" }
      : { review: true, reason: "external-read" };
  }

  if (WRITE_TOOLS.has(name)) {
    // A patch can add, move and delete several paths; parsing it is not worth
    // the risk of missing one, so patches are always reviewed.
    if (name === "apply_patch") return { review: true, reason: "patch" };
    if (typeof args.file_path !== "string" || args.file_path.trim() === "") {
      return { review: true, reason: "missing-path" };
    }
    const target = resolveScopePath(call.cwd, args.file_path);
    if (!isInsideProject(call.cwd, target)) {
      return { review: true, reason: "external-write" };
    }
    return isConfigFile(call.cwd, target)
      ? { review: true, reason: "config-write" }
      : { review: false, reason: "project-write" };
  }

  return { review: false, reason: "other-tool" };
}

/**
 * Decide whether one Auto review request needs the reviewer.
 *
 * `scope: "all"` reviews everything. Any other value (including a typo)
 * falls back to the sensitive scope, so a bad setting cannot silently disable
 * the filter's intended reviews.
 *
 * @param {{ messages?: unknown }} options
 * @param {{ scope?: unknown, reviewInternet?: boolean, reviewMcp?: boolean }} [settings]
 * @returns {{ review: boolean, reason: string }}
 */
export function reviewScopeDecision(options, settings = {}) {
  const mode = String(settings.scope ?? "").trim().toLowerCase();
  if (mode === SCOPE_ALL) return { review: true, reason: "scope-all" };
  const input = readReviewInput(options);
  if (input === undefined) return { review: true, reason: "unparseable" };
  return classifyToolCall(input, settings);
}

/**
 * Build the exact stream auto-review's `readDecision` expects for an allow.
 *
 * The shape matches `adaptQwen3GuardStream` in `review-route.js`: no reasoning
 * block, one text block carrying the decision JSON, then a stop finish.
 *
 * @returns {AsyncGenerator<object>}
 */
export async function* allowDecisionStream() {
  const text = JSON.stringify({ risk: "low", decision: "allow" });
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
