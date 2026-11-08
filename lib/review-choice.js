/**
 * Hand Auto review denials back to the user.
 *
 * The shipped Auto review gate (`dsh-experimental-auto-review`) ends a tool
 * call in one of three ways when its reviewer does not allow it:
 *
 * - `denied()`: `{kind:"deny", info:{code:"AUTO_REVIEW_DENIED"}}`, returned
 *   when the session approval override is `never`. Final, no prompt.
 * - `failed()`: `{kind:"deny", reason:'Auto review of tool "X" failed; ...'}`,
 *   returned when the reviewer threw, errored or (with our deadline) timed out.
 * - `askUser()`: `{kind:"ask", displayReason}`, which `dsh-tools` forwards to
 *   the approval service. Under the `never` policy that service rejects it
 *   without asking anybody.
 *
 * This module turns those outcomes into a `userQuestions` prompt so the user
 * picks "allow once" or "keep denied". Every failure to ask, a cancelled or
 * skipped prompt, and any answer other than the explicit allow option keep the
 * original gate result: nothing is ever allowed silently.
 */

/** Must match `AUTO_REVIEW_DENIED_CODE` in dsh-experimental-auto-review. */
export const AUTO_REVIEW_DENIED_CODE = "AUTO_REVIEW_DENIED";

/** Code of the synthetic finish chunk emitted when the reviewer is too slow. */
export const REVIEWER_TIMEOUT_CODE = "REVIEWER_TIMEOUT";

/** Question id used for the single review-choice question. */
export const REVIEW_CHOICE_QUESTION_ID = "dsh-auto-check-review-choice";

/** Labels are bilingual because the host side has no viewer locale. */
export const KEEP_DENIED_LABEL = "Keep denied / 维持拒绝 (recommended)";
export const ALLOW_ONCE_LABEL = "Allow once / 仍要执行（放行一次）";

const FAILED_REASON = /^Auto review of tool "/;

/**
 * Classify one `tools/pre-execute` gate result.
 *
 * `ask` is matched purely by shape; whether it would be auto-rejected depends
 * on the approval policy, which the caller checks.
 *
 * @param {unknown} gate
 * @returns {"denied" | "failed" | "ask" | undefined}
 */
export function reviewDenialKind(gate) {
  if (gate === null || typeof gate !== "object") return undefined;
  if (gate.kind === "deny") {
    if (gate.info?.code === AUTO_REVIEW_DENIED_CODE) return "denied";
    if (typeof gate.reason === "string" && FAILED_REASON.test(gate.reason)) {
      return "failed";
    }
    return undefined;
  }
  if (gate.kind === "ask" && typeof gate.reason === "string" && /^Auto review denied tool "/.test(gate.reason)) {
    return "ask";
  }
  return undefined;
}

/**
 * Whether a gate result is one of the three Auto review denial shapes.
 * @param {unknown} gate
 * @returns {boolean}
 */
export function isReviewDenial(gate) {
  return reviewDenialKind(gate) !== undefined;
}

/**
 * The most specific human-readable reason carried by a gate result.
 * @param {any} gate
 * @returns {string}
 */
export function denialReason(gate) {
  if (typeof gate?.info?.reason === "string" && gate.info.reason !== "") {
    return gate.info.reason;
  }
  const display = gate?.displayReason;
  if (display !== undefined && display !== null && typeof display === "object") {
    const zh = typeof display.zh === "string" ? display.zh : "";
    const en = typeof display.en === "string" ? display.en : "";
    if (zh !== "" || en !== "") return [en, zh].filter(Boolean).join("\n\n");
  }
  if (typeof display === "string" && display !== "") return display;
  return typeof gate?.reason === "string" ? gate.reason : "";
}

/** Indent text as a Markdown blockquote so reviewer output cannot restyle the card. */
function quote(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Longest argument text shown in the card before it is cut. */
export const MAX_DETAIL_CHARS = 4000;

/** Argument keys rendered as a shell block when they hold a string. */
const COMMAND_KEYS = ["command", "cmd", "script"];

/** Wrap text in a code fence longer than any backtick run inside it. */
function fence(text, lang = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function clip(text, max = MAX_DETAIL_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (${text.length - max} more chars / 另有 ${text.length - max} 个字符未显示)`;
}

function stringify(value) {
  try {
    const json = JSON.stringify(value, null, 2);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

/**
 * Render a tool call's arguments as Markdown: a shell block for the command
 * (when there is one) followed by the remaining fields as pretty JSON.
 * Strings that hold JSON are parsed first; anything else is shown verbatim.
 *
 * @param {unknown} args
 * @returns {string} Markdown, or "" when there is nothing to show.
 */
export function formatArguments(args) {
  let value = args;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    try {
      value = JSON.parse(trimmed);
    } catch {
      return fence(clip(value));
    }
    if (typeof value !== "object" || value === null) return fence(clip(args));
  }
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return fence(clip(String(value)));

  const parts = [];
  let rest = value;
  if (!Array.isArray(value)) {
    const key = COMMAND_KEYS.find((name) => typeof value[name] === "string" && value[name] !== "");
    if (key !== undefined) {
      parts.push(fence(clip(value[key]), "sh"));
      rest = { ...value };
      delete rest[key];
    }
  }
  if (Array.isArray(rest) ? rest.length > 0 : Object.keys(rest).length > 0) {
    parts.push(fence(clip(stringify(rest)), "json"));
  }
  return parts.join("\n\n");
}

/** The arguments of a `tools/pre-execute` call, whatever the host names them. */
function toolArguments(exec) {
  return exec?.arguments ?? exec?.args ?? exec?.input;
}

/**
 * Build the `userQuestions.ask` request for one blocked tool call.
 *
 * `options[0]` is the recommended "keep denied" option: the client preselects
 * it, so allowing always takes an explicit click. No `intent` is sent.
 *
 * @param {{ name?: unknown, agent?: unknown }} exec
 * @param {object} gate
 * @param {AbortSignal} [signal]
 * @returns {object}
 */
export function reviewQuestion(exec, gate, signal) {
  const kind = reviewDenialKind(gate);
  const name = typeof exec?.name === "string" ? exec.name : "unknown";
  const reason = denialReason(gate);
  const headline =
    kind === "failed"
      ? "The reviewer model did not answer (error or timeout). / 审查模型没有响应（出错或超时）。"
      : "The reviewer model blocked this tool call. / 审查模型拒绝了此工具调用。";
  const details = formatArguments(toolArguments(exec));
  const detail = [
    headline,
    "",
    `**Tool / 工具:** \`${name.replace(/`/g, "'")}\``,
    "",
    ...(details === "" ? [] : ["**Details / 详情:**", "", details, ""]),
    "**Reason / 原因:**",
    "",
    quote(reason === "" ? "(no reason given / 未给出原因)" : reason),
    "",
    "Allowing runs this one call now with full access; nothing else is approved. / 放行只执行这一次调用，不会放行其他调用。",
  ].join("\n");

  return {
    questions: [
      {
        id: REVIEW_CHOICE_QUESTION_ID,
        header: "Auto review",
        question: `Run tool "${name}" anyway? / 仍要执行工具 "${name}" 吗？`,
        detail,
        options: [
          {
            label: KEEP_DENIED_LABEL,
            description: "Do not run it; the agent sees the original denial. / 不执行，代理收到原拒绝结果。",
          },
          {
            label: ALLOW_ONCE_LABEL,
            description: "Run this call once, overriding the reviewer. / 越过审查，只执行这一次。",
          },
        ],
        multiSelect: false,
      },
    ],
    ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * Map a `userQuestions` answer to a decision. Only the exact allow option
 * allows; skipped, custom text, unknown labels and malformed answers deny.
 *
 * @param {unknown} answer - `{answers:[{id, selected:[label], custom?}]}`.
 * @param {string} [allowLabel]
 * @returns {"allow" | "deny"}
 */
export function resolveChoice(answer, allowLabel = ALLOW_ONCE_LABEL) {
  const answers = Array.isArray(answer?.answers) ? answer.answers : [];
  const entry =
    answers.find((item) => item?.id === REVIEW_CHOICE_QUESTION_ID) ??
    (answers.length === 1 ? answers[0] : undefined);
  const selected = Array.isArray(entry?.selected) ? entry.selected : [];
  if (selected.length !== 1) return "deny";
  return selected[0] === allowLabel ? "allow" : "deny";
}

/**
 * Build the outermost `tools/pre-execute` listener.
 *
 * @param {object} deps
 * @param {() => string} deps.onBlock - `"ask"` (default) or `"deny"`.
 * @param {() => any} deps.userQuestions - current userQuestions service or undefined.
 * @param {() => any} deps.approval - current approval service or undefined.
 * @param {(error: unknown) => void} [deps.onAskError] - diagnostics hook.
 * @returns {(exec: any, next: () => Promise<any>) => Promise<any>}
 */
export function createReviewChoiceListener(deps) {
  return async function reviewChoice(exec, next) {
    const gate = await next();
    try {
      if (String(deps.onBlock() ?? "ask").trim().toLowerCase() === "deny") return gate;
      const kind = reviewDenialKind(gate);
      if (kind === undefined) return gate;
      const agent = exec?.agent;
      if (agent === undefined) return gate;
      if (kind === "ask") {
        // Under the `ask` policy the approval card already asks the user.
        const approval = deps.approval();
        const policy = approval?.effectivePolicy?.(agent.session);
        if (policy !== "never") return gate;
      }
      const questions = deps.userQuestions();
      if (typeof questions?.ask !== "function") return gate;

      const signal = exec.signal instanceof AbortSignal ? exec.signal : undefined;
      const answer = await questions.ask(reviewQuestion(exec, gate, signal));
      if (signal?.aborted) return gate;
      return resolveChoice(answer) === "allow" ? { kind: "allow" } : gate;
    } catch (error) {
      // NO_PROVIDER, ASK_CANCELLED, ASK_ABORTED, CALLER_NOT_LIVE, ... all
      // keep the original denial. Never fall through to allow.
      try {
        deps.onAskError?.(error);
      } catch {
        // Diagnostics must never change the decision.
      }
      return gate;
    }
  };
}

/**
 * Bound how long a reviewer stream may take to reach its terminal finish.
 *
 * When the deadline passes first, `onTimeout` runs (the caller aborts the
 * underlying request) and a synthetic error finish is emitted. Auto review's
 * `readDecision` turns it into `failed()`, which the choice listener then
 * hands to the user. `timeoutMs <= 0` or non-finite disables the deadline.
 *
 * @param {AsyncIterable<object>} stream
 * @param {number} timeoutMs
 * @param {() => void} [onTimeout]
 * @returns {AsyncGenerator<object>}
 */
export async function* withReviewDeadline(stream, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    yield* stream;
    return;
  }
  const iterator = stream[Symbol.asyncIterator]();
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  let finished = false;
  let done = false;
  try {
    while (true) {
      const step = finished ? await iterator.next() : await Promise.race([iterator.next(), expired]);
      if (step === TIMED_OUT) {
        try {
          onTimeout?.();
        } catch {
          // Aborting is best effort; the synthetic finish is what matters.
        }
        Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => {});
        done = true;
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: {
              code: REVIEWER_TIMEOUT_CODE,
              message: `reviewer did not finish within ${timeoutMs} ms`,
            },
          },
        };
        return;
      }
      if (step.done) {
        done = true;
        return;
      }
      if (step.value?.type === "finish") {
        finished = true;
        clearTimeout(timer);
      }
      yield step.value;
    }
  } finally {
    clearTimeout(timer);
    if (!done) await iterator.return?.();
  }
}

const TIMED_OUT = Symbol("timed-out");

/**
 * Keep one `tools/pre-execute` listener outermost in the cordis waterfall.
 *
 * cordis `register()` uses `unshift` for `prepend`, and `waterfall()` runs
 * index 0 first, so the most recently registered prepend listener is the
 * outermost one. The Auto review gate registers itself with `prepend: true`
 * inside its own lifecycle effect, which may run before or after this plugin
 * depending on service availability. To see the gate's result we must wrap it,
 * so whenever another prepend listener for the same event registers, this
 * re-registers ours on the next microtask, putting it back at index 0.
 *
 * @param {any} ctx - cordis context.
 * @param {string} name - event name.
 * @param {Function} listener
 * @param {(error: unknown) => void} [onError]
 * @returns {() => void} disposer.
 */
export function keepOutermost(ctx, name, listener, onError) {
  const options = { global: true, prepend: true };
  let disposed = false;
  let moving = false;
  let pending = false;
  let dispose = ctx.on(name, listener, options);

  const disposeWatch = ctx.on(
    "internal/listener",
    (event, _listener, listenerOptions) => {
      if (event !== name || moving || pending || disposed) return undefined;
      if (listenerOptions !== true && !listenerOptions?.prepend) return undefined;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (disposed) return;
        moving = true;
        try {
          dispose();
          dispose = ctx.on(name, listener, options);
        } catch (error) {
          onError?.(error);
        } finally {
          moving = false;
        }
      });
      return undefined;
    },
    { global: true },
  );

  return () => {
    disposed = true;
    disposeWatch();
    dispose();
  };
}
