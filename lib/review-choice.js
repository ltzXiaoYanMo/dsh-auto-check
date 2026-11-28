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

/** Card language values, as `card-language.js` resolves them. */
export const CARD_LANGUAGE_ZH = "zh";
export const CARD_LANGUAGE_EN = "en";

/**
 * Keep-denied option label for one card language.
 *
 * `undefined` (viewer language unknown) keeps the bilingual rendering: the
 * client preselects `options[0]` when its label ends in a recommended suffix,
 * in either parenthesis width.
 *
 * @param {"zh" | "en" | undefined} [language]
 * @returns {string}
 */
export function keepDeniedLabel(language) {
  if (language === CARD_LANGUAGE_ZH) return "维持拒绝（推荐）";
  if (language === CARD_LANGUAGE_EN) return "Keep denied (recommended)";
  return KEEP_DENIED_LABEL;
}

/**
 * Allow-once option label for one card language. `undefined` keeps the
 * bilingual rendering; the answer compares against exactly this label.
 *
 * @param {"zh" | "en" | undefined} [language]
 * @returns {string}
 */
export function allowOnceLabel(language) {
  if (language === CARD_LANGUAGE_ZH) return "仍要执行（放行一次）";
  if (language === CARD_LANGUAGE_EN) return "Allow once";
  return ALLOW_ONCE_LABEL;
}

/** Bilingual labels: the Host side has no viewer locale of its own. */
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
 *
 * A `displayReason` map is per-locale copy: with a known card language only
 * that entry is used (the other language of the pair, or `en`, standing in
 * when the chosen entry is missing); without one both halves are joined, the
 * long-standing bilingual rendering.
 *
 * @param {any} gate
 * @param {"zh" | "en" | undefined} [language] - card language, when known.
 * @returns {string}
 */
export function denialReason(gate, language) {
  if (typeof gate?.info?.reason === "string" && gate.info.reason !== "") {
    return gate.info.reason;
  }
  const display = gate?.displayReason;
  if (display !== undefined && display !== null && typeof display === "object") {
    const zh = typeof display.zh === "string" ? display.zh : "";
    const en = typeof display.en === "string" ? display.en : "";
    if (language === CARD_LANGUAGE_ZH) return zh !== "" ? zh : en !== "" ? en : "";
    if (language === CARD_LANGUAGE_EN) return en !== "" ? en : zh !== "" ? zh : "";
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

/** Longest auxiliary argument text shown in the card before it is cut. */
export const MAX_DETAIL_CHARS = 4000;

/**
 * Longest reviewer text shown in the card before it is folded.
 *
 * Reviewer output is unbounded: a gateway error, a stack trace or a model that
 * ignores its instructions can return tens of kilobytes, which pushes the two
 * decision buttons out of view. The command and the verdict stay outside this
 * budget — the command is what the user must be able to read in full.
 */
export const MAX_REASON_CHARS = 1200;

/** Argument keys rendered as a shell block when they hold a string. */
const COMMAND_KEYS = ["command", "cmd", "script"];

/** Wrap text in a code fence longer than any backtick run inside it. */
function fence(text, lang = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/** Clip note: how many characters are not shown, in the card language. */
function clipNote(language, hidden) {
  if (language === CARD_LANGUAGE_ZH) return `...（另有 ${hidden} 个字符未显示）`;
  if (language === CARD_LANGUAGE_EN) return `... (${hidden} more chars)`;
  return `... (${hidden} more chars / 另有 ${hidden} 个字符未显示)`;
}

function clip(text, max = MAX_DETAIL_CHARS, language) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n${clipNote(language, text.length - max)}`;
}

/**
 * Fold over-long text, keeping both ends and reporting how much was dropped.
 *
 * The tail matters as much as the head here: gateways report the failure code
 * at the end of the message (`reviewer ended with error REVIEWER_TIMEOUT`), and
 * the head names what was blocked. Truncating one end only would hide one of
 * the two.
 */
function fold(text, max = MAX_REASON_CHARS, language) {
  if (text.length <= max) return text;
  const note = foldNote(language, text.length - max);
  const budget = Math.max(0, max - note.length - 2);
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}\n${note}\n${text.slice(-tail)}`;
}

/** Fold note: how many characters were folded away, in the card language. */
function foldNote(language, folded) {
  if (language === CARD_LANGUAGE_ZH) return `...（另有 ${folded} 个字符已折叠）`;
  if (language === CARD_LANGUAGE_EN) return `... (${folded} more chars folded)`;
  return `... (${folded} more chars folded / 另有 ${folded} 个字符已折叠)`;
}

/** Prefixes the host and the adapter wrap around the reviewer's own text. */
const REASON_WRAPPER = /^(?:Auto review[^:：]*|自动审查[^:：]*)[:：]\s*/i;

/** The reviewer payload of one line, with the host wrapper removed. */
function payload(line) {
  return line.replace(REASON_WRAPPER, "").replace(/\s+/g, " ").trim();
}

/** Whether text carries Chinese-script characters (CJK ideographs, kana, full-width forms). */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Reduce reviewer text to a single language before it reaches the card.
 *
 * `denialReason` joins the English and Chinese renderings of the *same* host
 * message with a blank line, and for an `ask` gate that doubles a sentence the
 * user only needs once. When both halves carry the same payload, the half
 * matching the card language is kept (the default keeps the Chinese half,
 * because the reviewer is instructed to answer in Chinese; a bilingual card
 * needs only one rendering either way).
 *
 * @param {unknown} reason
 * @param {"zh" | "en" | undefined} [language] - card language, when known.
 * @returns {string}
 */
export function collapseReason(reason, language) {
  const text = String(reason ?? "").replace(/\r\n/g, "\n").trim();
  if (text === "") return "";
  const halves = text.split(/\n{2,}/);
  const duplicated = halves.length === 2 && payload(halves[0]) === payload(halves[1]);
  const kept = duplicated ? matchingHalf(halves, language) : text;
  return kept
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The half of a duplicated bilingual message that matches the card language.
 *
 * @param {[string, string]} halves - the English and Chinese renderings, in
 *   the order the host joined them.
 * @param {"zh" | "en" | undefined} language
 * @returns {string}
 */
function matchingHalf(halves, language) {
  if (language === undefined) return halves[1];
  const firstChinese = CJK.test(halves[0]);
  const secondChinese = CJK.test(halves[1]);
  // Exactly one half is Chinese-script: the zh card takes that half, the en
  // card the other one.
  if (firstChinese !== secondChinese) {
    return (language === CARD_LANGUAGE_ZH) === firstChinese ? halves[0] : halves[1];
  }
  // Both halves read alike: keep the historical defaults.
  return language === CARD_LANGUAGE_ZH ? halves[1] : halves[0];
}

/** Fold over-long reviewer text; a no-op for text within budget. */
export function foldReason(reason, max = MAX_REASON_CHARS, language) {
  return fold(collapseReason(reason, language), max, language);
}

const QWEN3GUARD_LABEL = /Qwen3Guard:\s*(Safe|Unsafe|Controversial)\s*\(([^\n]*)\)/i;
const QWEN3GUARD_MISSING = /Qwen3Guard returned no Safety label/i;
/** Any label occurrence, for cleanup of whatever is left over. */
const QWEN3GUARD_ANY =
  /Qwen3Guard:\s*(?:Safe|Unsafe|Controversial)\s*\([^\n]*\)|Qwen3Guard returned no Safety label/gi;
const LABEL_CASE = { safe: "Safe", unsafe: "Unsafe", controversial: "Controversial" };

/**
 * Text left once every label and host wrapper is removed.
 *
 * Both language halves of a duplicated host message carry the label, so a
 * single replacement is not enough: the leftover after the first match is the
 * whole second half.
 */
function remainderOf(text) {
  return text
    .replace(QWEN3GUARD_ANY, " ")
    .replace(REASON_WRAPPER, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.，。；：\-—–]+|[\s:;,.，。；：\-—–]+$/g, "")
    .trim();
}

/**
 * Split a Qwen3Guard denial into its verdict and whatever else the reason says.
 *
 * The adapter encodes the label as `Qwen3Guard: Unsafe (categories: Violent)`,
 * which reads as prose. The card shows the two fields the user has to act on —
 * `Safety` and `Categories` — as one block, so the label is never buried in a
 * paragraph and the category list is not reflowed into the sentence.
 *
 * @param {unknown} reason
 * @param {"zh" | "en" | undefined} [language] - card language, when known.
 * @returns {{ verdict: string, remainder: string } | undefined}
 */
export function qwen3GuardVerdict(reason, language) {
  const text = collapseReason(reason, language);
  const labelled = QWEN3GUARD_LABEL.exec(text);
  if (labelled !== null) {
    const label = LABEL_CASE[labelled[1].toLowerCase()] ?? labelled[1];
    const categories = /^categories:\s*(.*)$/i.exec(labelled[2].trim())?.[1]?.trim();
    return {
      verdict: `Safety: ${label}\nCategories: ${
        categories === undefined || categories === "" ? "None" : categories
      }`,
      remainder: remainderOf(text),
    };
  }
  if (QWEN3GUARD_MISSING.test(text)) {
    return {
      verdict: "Safety: (no label returned)\nCategories: (unknown)",
      remainder: remainderOf(text),
    };
  }
  return undefined;
}

/**
 * Render one denial reason body, whatever shape the reviewer answered in.
 *
 * The card has exactly one `Reason / 原因` section for every denial kind: a
 * Qwen3Guard verdict leads the text as `Safety:` / `Categories:` lines and the
 * rest of the reviewer sentence follows, instead of a separate verdict block
 * plus a note section. Non-Qwen3Guard text passes through unchanged.
 *
 * @param {unknown} reason
 * @param {"zh" | "en" | undefined} [language] - card language, when known.
 * @returns {string}
 */
export function reasonText(reason, language) {
  const verdict = qwen3GuardVerdict(reason, language);
  if (verdict === undefined) return String(reason ?? "");
  return [verdict.verdict, verdict.remainder].filter((part) => part !== "").join("\n\n");
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
 * Split a tool call's arguments into the part that is the operation and the
 * rest.
 *
 * `command` is the shell block for the command (or, for a tool that takes a
 * bare string, that string): it is what the user is authorising, so it is never
 * clipped. `rest` holds the other fields as pretty JSON and is clipped.
 * Strings that hold JSON are parsed first; anything else is shown verbatim.
 *
 * @param {unknown} args
 * @param {"zh" | "en" | undefined} [language] - card language, when known.
 * @returns {{ command?: string, rest?: string }}
 */
export function describeArguments(args, language) {
  let value = args;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return {};
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { command: fence(args) };
    }
    if (typeof value !== "object" || value === null) return { command: fence(args) };
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") return { command: fence(String(value)) };

  const parts = {};
  let rest = value;
  if (!Array.isArray(value)) {
    const key = COMMAND_KEYS.find((name) => typeof value[name] === "string" && value[name] !== "");
    if (key !== undefined) {
      parts.command = fence(value[key], "sh");
      rest = { ...value };
      delete rest[key];
    }
  }
  if (Array.isArray(rest) ? rest.length > 0 : Object.keys(rest).length > 0) {
    parts.rest = fence(clip(stringify(rest), MAX_DETAIL_CHARS, language), "json");
  }
  return parts;
}

/**
 * Render a tool call's arguments as Markdown: a shell block for the command
 * (when there is one) followed by the remaining fields as pretty JSON.
 *
 * @param {unknown} args
 * @param {"zh" | "en" | undefined} [language] - card language, when known.
 * @returns {string} Markdown, or "" when there is nothing to show.
 */
export function formatArguments(args, language) {
  const { command, rest } = describeArguments(args, language);
  return [command, rest].filter((part) => part !== undefined).join("\n\n");
}

/** The arguments of a `tools/pre-execute` call, whatever the host names them. */
function toolArguments(exec) {
  return exec?.arguments ?? exec?.args ?? exec?.input;
}

/**
 * Card copy for one language.
 *
 * `undefined` (viewer language unknown) keeps the bilingual rendering: both
 * sentences, joined with " / ", exactly as the card has always shown them.
 *
 * @param {"zh" | "en" | undefined} language
 */
function cardCopy(language) {
  const pick = (en, zh) =>
    language === CARD_LANGUAGE_ZH
      ? zh
      : language === CARD_LANGUAGE_EN
        ? en
        : `${en} / ${zh}`;
  return {
    question: (name) =>
      language === CARD_LANGUAGE_ZH
        ? `仍要执行工具 "${name}" 吗？`
        : language === CARD_LANGUAGE_EN
          ? `Run tool "${name}" anyway?`
          : `Run tool "${name}" anyway? / 仍要执行工具 "${name}" 吗？`,
    headlineFailed: pick(
      "The reviewer model did not answer (error or timeout).",
      "审查模型没有响应（出错或超时）。",
    ),
    headlineDenied: pick(
      "The reviewer model blocked this tool call.",
      "审查模型拒绝了此工具调用。",
    ),
    tool: pick("Tool", "工具"),
    command: pick("Command", "命令"),
    arguments: pick("Arguments", "参数"),
    reason: pick("Reason", "原因"),
    noReason:
      language === CARD_LANGUAGE_ZH
        ? "（未给出原因）"
        : language === CARD_LANGUAGE_EN
          ? "(no reason given)"
          : "(no reason given / 未给出原因)",
    allowWarning: pick(
      "Allowing runs this one call now with full access; nothing else is approved.",
      "放行只执行这一次调用，不会放行其他调用。",
    ),
    keepDeniedDetail: pick(
      "Do not run it; the agent sees the original denial.",
      "不执行，代理收到原拒绝结果。",
    ),
    allowOnceDetail: pick(
      "Run this call once, overriding the reviewer.",
      "越过审查，只执行这一次。",
    ),
  };
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
 * @param {"zh" | "en" | undefined} [language] - card language, when known;
 *   `undefined` keeps the bilingual rendering.
 * @returns {object}
 */
export function reviewQuestion(exec, gate, signal, language) {
  const kind = reviewDenialKind(gate);
  const name = typeof exec?.name === "string" ? exec.name : "unknown";
  const copy = cardCopy(language);
  const raw = denialReason(gate, language);
  const { command, rest } = describeArguments(toolArguments(exec), language);
  // A reviewer that never answered carries no verdict of its own: its error text
  // is the reason, verbatim.
  const note = foldReason(
    kind === "failed" ? raw : reasonText(raw, language),
    MAX_REASON_CHARS,
    language,
  );
  const headline = kind === "failed" ? copy.headlineFailed : copy.headlineDenied;
  // Fixed order for every denial kind: tool, what it will run, then why. The
  // verdict of a Qwen3Guard reviewer is part of the reason, not a block of its own.
  const detail = [
    headline,
    "",
    `**${copy.tool}:** \`${name.replace(/`/g, "'")}\``,
    "",
    ...(command === undefined ? [] : [`**${copy.command}:**`, "", command, ""]),
    ...(rest === undefined ? [] : [`**${copy.arguments}:**`, "", rest, ""]),
    `**${copy.reason}:**`,
    "",
    quote(note === "" ? copy.noReason : note),
    "",
    copy.allowWarning,
  ].join("\n");

  return {
    questions: [
      {
        id: REVIEW_CHOICE_QUESTION_ID,
        header: "Auto review",
        question: copy.question(name),
        detail,
        options: [
          {
            label: keepDeniedLabel(language),
            description: copy.keepDeniedDetail,
          },
          {
            label: allowOnceLabel(language),
            description: copy.allowOnceDetail,
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
 * Turn an `ask` gate into the terminal denial the user just chose.
 *
 * `ask` is not a decision: it is Auto review handing the question to the host's
 * approval card. Once the user answers that question here, returning the same
 * `ask` gate would make the host ask a second time. The shape below is the one
 * Auto review's own `denied()` builds, so every consumer that detects
 * `AUTO_REVIEW_DENIED` keeps working.
 *
 * @param {{ name?: unknown }} exec
 * @param {any} gate
 * @returns {object}
 */
export function hardenAskDenial(exec, gate) {
  const name = typeof exec?.name === "string" ? exec.name : "unknown";
  const reason = reasonText(collapseReason(denialReason(gate)));
  return {
    kind: "deny",
    reason: `Auto review rejected tool "${name}"; its body was not executed`,
    info: {
      // Same values Auto review's denied() emits; other plugins key on them.
      name: "AutoReviewDeniedError",
      code: AUTO_REVIEW_DENIED_CODE,
      ...(reason === "" ? {} : { reason }),
    },
  };
}

/**
 * Build the outermost `tools/pre-execute` listener.
 *
 * @param {object} deps
 * @param {() => string} deps.onBlock - `"ask"` (default) or `"deny"`.
 * @param {() => any} deps.userQuestions - current userQuestions service or undefined.
 * @param {() => "zh" | "en" | undefined} [deps.language] - resolves the card
 *   language from the DSH locale setting (see `card-language.js`); absent or
 *   failing resolution keeps the bilingual card.
 * @param {() => any} [deps.approval] - accepted for compatibility; the approval
 *   policy no longer decides whether this listener asks. It asks for every
 *   denial kind and hardens `ask` gates itself, so the user sees one card.
 * @param {(error: unknown) => void} [deps.onAskError] - diagnostics hook.
 * @returns {(exec: any, next: () => Promise<any>) => Promise<any>}
 */
export function createReviewChoiceListener(deps) {
  return async function reviewChoice(exec, next) {
    // A question to the user is the interaction itself. Reviewing it first
    // adds a redundant "allow this tool?" card before the real question, so
    // let interactive question tools execute directly.
    if (exec?.name === "ask_user_question") return { kind: "allow" };
    const gate = await next();
    try {
      if (String(deps.onBlock() ?? "ask").trim().toLowerCase() === "deny") return gate;
      const kind = reviewDenialKind(gate);
      if (kind === undefined) return gate;
      const agent = exec?.agent;
      if (agent === undefined) return gate;
      const questions = deps.userQuestions();
      if (typeof questions?.ask !== "function") return gate;

      // Language resolution is display-only: any failure falls back to the
      // bilingual card rather than blocking the question.
      let language;
      try {
        language = typeof deps.language === "function" ? deps.language() : undefined;
      } catch {
        language = undefined;
      }

      const signal = exec.signal instanceof AbortSignal ? exec.signal : undefined;
      const answer = await questions.ask(reviewQuestion(exec, gate, signal, language));
      if (signal?.aborted) return gate;
      if (resolveChoice(answer, allowOnceLabel(language)) === "allow") return { kind: "allow" };
      return kind === "ask" ? hardenAskDenial(exec, gate) : gate;
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
