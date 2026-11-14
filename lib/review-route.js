/**
 * Pure routing and protocol adaptation for Auto review requests.
 *
 * The shipped auto-review plugin renders its policy as the request's `system`
 * prompt, and that prompt starts with this exact line. The request carries no
 * session id or other metadata, so the prefix is the only stable marker.
 */
export const REVIEW_POLICY_PREFIX = "REVIEW_POLICY\n";

/**
 * Marker of the appended reason block. A request that already carries it is
 * never extended a second time, so re-entered copies stay idempotent.
 */
export const REASON_POLICY_MARKER = "REVIEW_ADDENDUM_ZH";

/**
 * Instructions appended to the shipped JSON policy.
 *
 * The host's `parseDecision` counts the members of the returned object, so the
 * shapes, the risk classes and the "stop after the closing brace" rule must not
 * change. Only the `reason` member is constrained further: it is the single
 * piece of reviewer text the user reads in the denial dialog, and in the
 * shipped policy it is both optional and unconstrained.
 */
export const REASON_POLICY_ZH = `${REASON_POLICY_MARKER}
Everything above stays in force: the same shapes, the same risk classes, the same authority rules, and the same "stop after the closing brace" ending. This block adds one requirement about reason, which the user reads in a dialog before deciding whether the call may run:
- Every deny object must carry reason. A deny without reason leaves the user unable to judge the call and is not accepted.
- reason must be written in Simplified Chinese (简体中文) only. Keep the JSON keys exactly as shown, never translate them, and never answer in English, Traditional Chinese or any other language.
- reason must state both parts, in this order, in one or two sentences: (1) 这次操作会做什么 — the concrete effect of the pending call, naming the command, target, path, host, data or scope it actually touches; (2) 为什么拒绝 — the risk class or rule it violates, and, when the only problem is missing authorization, which explicit authorization would allow it.
- Keep reason a single short JSON string: no line breaks, no Markdown, no large excerpts copied from the reviewed content, no prose around the object.
- An allow object still has exactly two members and still carries no reason.
The output contract is unchanged and final: exactly one JSON object and no other text, with the closing brace as the last character you emit.`;

/**
 * Append the reason requirement to an Auto review policy prompt.
 *
 * Returns the input unchanged for anything that is not the Auto review policy,
 * and for a policy that already carries the marker.
 *
 * @param {unknown} system
 * @returns {unknown}
 */
export function withReasonPolicy(system) {
  if (typeof system !== "string" || !system.startsWith(REVIEW_POLICY_PREFIX)) {
    return system;
  }
  if (system.includes(REASON_POLICY_MARKER)) return system;
  return `${system}\n\n${REASON_POLICY_ZH}`;
}

/**
 * Requests we have already rewritten. `llm/stream` listeners may re-enter
 * `ctx.llm.stream`, and the re-entered request must pass through to the adapter
 * instead of matching this plugin again. The set is module scoped because the
 * profile loads this plugin once.
 */
const rewritten = new WeakSet();

/**
 * Whether one LLM request is the Auto review request.
 * @param {{ system?: unknown }} options
 * @returns {boolean}
 */
export function isReviewRequest(options) {
  return (
    typeof options.system === "string" &&
    options.system.startsWith(REVIEW_POLICY_PREFIX)
  );
}

/**
 * Qwen3Guard model ids are usually `Qwen/Qwen3Guard-Gen-4B` or
 * `Qwen3Guard-Gen-8B`; the family name is enough to select the adapter.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isQwen3GuardModel(model) {
  return typeof model === "string" && /qwen3guard/i.test(model);
}

/**
 * Resolve the output protocol for a target route.
 *
 * `auto` uses the Qwen3Guard adapter only when the target model is in that
 * family, so selecting a Qwen3Guard model works without a second setting.
 * `json` keeps the shipped auto-review protocol. `qwen3guard` forces the
 * adapter even for a differently named model (for example a local alias).
 *
 * @param {{ protocol?: unknown }} route
 * @param {unknown} targetModel
 * @returns {"json" | "qwen3guard"}
 */
export function resolveReviewProtocol(route, targetModel) {
  const protocol = String(route.protocol ?? "auto").trim().toLowerCase();
  if (protocol === "qwen3guard") return "qwen3guard";
  if (protocol === "json") return "json";
  return isQwen3GuardModel(targetModel) ? "qwen3guard" : "json";
}

/**
 * Read one message's text the way the review prompt lays it out.
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Collect the review prompt one part per message.
 *
 * Auto review renders `ENVIRONMENT`, `FILTERED_HISTORY` and `PENDING_ACTION`
 * as separate messages, and the pending tool call is always the last one. The
 * per-message split is what lets truncation keep the parts that matter.
 *
 * @param {{ messages?: unknown }} options
 * @returns {string[]}
 */
export function reviewTexts(options) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const parts = [];
  for (const message of messages) {
    const text = messageText(message);
    if (text !== "") parts.push(text);
  }
  if (parts.length > 0) return parts;
  return typeof options.messages === "string" && options.messages !== ""
    ? [options.messages]
    : [];
}

/**
 * Collect the text Auto review sent for the pending tool call.
 * @param {{ messages?: unknown }} options
 * @returns {string}
 */
export function reviewText(options) {
  return reviewTexts(options).join("\n\n");
}

const TRUNCATION_MARKER =
  "\n\n[... auto-review input truncated to fit the reviewer context window ...]\n\n";

/**
 * @param {number} dropped
 * @returns {string}
 */
function dropMarker(dropped) {
  return `[... auto-review input truncated: ${dropped} earlier history message(s) dropped ...]`;
}

/**
 * Trim a review prompt while preserving both ends.
 *
 * Kept for the single-message case and as the last-resort fallback; multi
 * message prompts go through {@link fitReviewTexts}, which drops whole history
 * messages instead of cutting through them.
 *
 * @param {string} text
 * @param {number} maxChars - 0 or a non-finite value keeps the text unchanged.
 * @returns {string}
 */
export function truncateReviewText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(-maxChars);

  const budget = maxChars - TRUNCATION_MARKER.length;
  const head = Math.floor(budget * 0.25);
  const tail = budget - head;
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(-tail);
}

/**
 * Fit a multi-part review prompt into a character budget.
 *
 * The environment header and the pending tool call are the two parts the
 * reviewer cannot work without, so they are reserved first and the pending
 * call is never dropped. History messages are then admitted newest first, and
 * anything that no longer fits is dropped as a whole instead of being cut in
 * half. A cut inside a JSON tool call is what makes small models echo the
 * prompt or emit special tokens instead of a label.
 *
 * @param {string[]} parts - one part per message, pending call last.
 * @param {number} maxChars - 0 or a non-finite value keeps the text unchanged.
 * @returns {string}
 */
export function fitReviewTexts(parts, maxChars) {
  const joined = parts.join("\n\n");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return joined;
  if (joined.length <= maxChars) return joined;
  if (parts.length <= 1) return truncateReviewText(joined, maxChars);

  const pending = parts[parts.length - 1];
  const pendingBudget = Math.max(
    Math.min(pending.length, 400),
    Math.floor(maxChars * 0.5),
  );
  const keptPending =
    pending.length > pendingBudget
      ? truncateReviewText(pending, pendingBudget)
      : pending;

  // Reserve the largest marker this prompt can produce, so the result is
  // always inside the budget without a second pass.
  const markerReserve = dropMarker(parts.length).length + 2;
  let room = maxChars - keptPending.length - 2 - markerReserve;
  if (room <= 0) return truncateReviewText(keptPending, maxChars);

  const lead = parts[0];
  let keptLead;
  if (lead.length <= room) {
    keptLead = lead;
    room -= lead.length + 2;
  } else {
    keptLead = room > TRUNCATION_MARKER.length ? truncateReviewText(lead, room) : "";
    room = 0;
  }

  const kept = [];
  for (let index = parts.length - 2; index >= 1; index -= 1) {
    const part = parts[index];
    if (part.length + 2 > room) continue;
    kept.unshift(part);
    room -= part.length + 2;
  }

  const dropped = parts.length - 2 - kept.length;
  const pieces = [];
  if (keptLead !== "") pieces.push(keptLead);
  if (dropped > 0) pieces.push(dropMarker(dropped));
  pieces.push(...kept, keptPending);
  const fitted = pieces.join("\n\n");
  return fitted.length <= maxChars ? fitted : truncateReviewText(joined, maxChars);
}

/**
 * Budget of the automatic second attempt after a prompt without a label.
 *
 * Measured against a real gateway, degenerate answers cluster above roughly
 * 30k characters of prompt, and re-asking with 8k recovers the label. The
 * attempt only happens when the first answer carried no label.
 */
export const QWEN3GUARD_RETRY_CHARS = 8000;

/**
 * Build the request Qwen3Guard expects.
 *
 * Qwen3Guard-Gen uses a fixed chat template for safety classification and does
 * not follow auto-review's JSON policy. Sending the policy as a system message
 * would be classified as part of the content, so only the pending-action text
 * is forwarded as the user turn. The output is short (`Safety:` plus
 * `Categories:`), so 128 tokens is ample. `store` is stripped because some
 * OpenAI-compatible gateways reject it outright.
 *
 * @param {object} options - immutable Auto review request.
 * @param {string} provider
 * @param {string} model
 * @param {number} [maxInputChars] - 0 disables truncation.
 * @param {{ pendingOnly?: boolean }} [shape] - `pendingOnly` keeps only the last
 *   message (the tool call under review), used by the shrinking retry.
 * @returns {object}
 */
export function qwen3GuardRequest(
  options,
  provider,
  model,
  maxInputChars = 0,
  shape = {},
) {
  const { system: _system, messages: _messages, store: _store, ...rest } = options;
  const all = reviewTexts(options);
  const parts =
    shape.pendingOnly === true && all.length > 1 ? [all[all.length - 1]] : all;
  const text = fitReviewTexts(parts, maxInputChars);
  return {
    ...rest,
    provider,
    model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text }],
      },
    ],
    maxTokens: 128,
  };
}

/** Fixed reason used when the reviewer answer carries no safety label. */
export const NO_LABEL_REASON =
  "Qwen3Guard 没有返回可识别的 Safety 标签（模型输出异常），已按最保守策略拒绝。";

/** Same, after the automatic shrinking retry also failed. */
export const NO_LABEL_RETRIED_REASON =
  "Qwen3Guard 没有返回可识别的 Safety 标签（模型输出异常，缩小输入重试后仍失败），已按最保守策略拒绝。";

/**
 * Keep reviewer text out of the dialog unless it is short and readable.
 *
 * Model output can degenerate into chat-template tokens, markdown fragments or
 * a repeat of the prompt. None of that belongs in a denial card: it is
 * unreadable and it can be long enough to hide the buttons. Only the two short
 * fields below are ever quoted, and only after this filter.
 *
 * @param {unknown} text
 * @param {number} [limit]
 * @returns {string}
 */
export function sanitizeReviewerText(text, limit = 120) {
  const cleaned = String(text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<\/?[A-Za-z!][^<>]{0,40}>/g, " ")
    .replace(/<\|[^|<>]{0,40}\|>/g, " ")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Number of leading characters searched for the safety label.
 *
 * Qwen3Guard answers with `Safety: ...` first. A degenerate answer instead
 * repeats the reviewed content, and that content can itself mention a label
 * (this repository's own sources do), so a label found deep inside the answer
 * is not a verdict.
 */
export const LABEL_SCAN_CHARS = 300;

/**
 * Whether a reviewer answer carried a usable safety label.
 * @param {string} text
 * @returns {boolean}
 */
export function hasSafetyLabel(text) {
  return /Safety:\s*(Safe|Unsafe|Controversial)/i.test(
    String(text ?? "").slice(0, LABEL_SCAN_CHARS),
  );
}

/**
 * Map a Qwen3Guard safety label to auto-review's risk/decision protocol.
 *
 * `Safe` allows. `Unsafe` is high risk and denies. `Controversial` is context
 * dependent; this adapter treats it as medium risk and denies so the user can
 * still decide through auto-review's ask path when the downstream policy
 * allows. A missing label fails closed, and the reason is a fixed sentence:
 * the raw answer is never quoted into the dialog.
 *
 * @param {string} text
 * @param {{ attempts?: number }} [context] - `attempts > 1` means the shrinking
 *   retry already ran and found no label either.
 * @returns {{ risk: "low" | "medium" | "high", decision: "allow" | "deny", reason?: string }}
 */
export function qwen3GuardDecision(text, context = {}) {
  const head = String(text ?? "").slice(0, LABEL_SCAN_CHARS);
  const label = /Safety:\s*(Safe|Unsafe|Controversial)/i.exec(head)?.[1]?.toLowerCase();
  const rawCategories = /Categories:\s*([^\n]+)/i.exec(head)?.[1];
  const categories = rawCategories === undefined ? "" : sanitizeReviewerText(rawCategories, 60);
  const detail =
    categories !== "" && !/^none$/i.test(categories)
      ? `categories: ${categories}`
      : "no category";

  if (label === "safe") return { risk: "low", decision: "allow" };
  if (label === "controversial") {
    return {
      risk: "medium",
      decision: "deny",
      reason: `Qwen3Guard: Controversial (${detail})`,
    };
  }
  if (label === "unsafe") {
    return {
      risk: "high",
      decision: "deny",
      reason: `Qwen3Guard: Unsafe (${detail})`,
    };
  }

  return {
    risk: "high",
    decision: "deny",
    reason: Number(context.attempts) > 1 ? NO_LABEL_RETRIED_REASON : NO_LABEL_REASON,
  };
}

/**
 * Drain one reviewer stream into the pieces the decision needs.
 *
 * @param {AsyncIterable<object>} stream
 * @returns {Promise<{ text: string, usage?: object, finish?: object }>}
 */
async function collectQwen3Guard(stream) {
  let text = "";
  let usage;
  let finish;
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== "object") continue;
    switch (chunk.type) {
      case "text-delta":
        text += typeof chunk.text === "string" ? chunk.text : "";
        break;
      case "usage":
        usage = chunk;
        break;
      case "finish":
        finish = chunk;
        break;
      default:
        break;
    }
  }
  return { text, usage, finish };
}

/**
 * Consume Qwen3Guard's native text stream and emit the one-text-block JSON
 * stream auto-review's `readDecision` requires.
 *
 * Adapter errors are passed through as their terminal finish chunk so
 * auto-review keeps its existing fail-closed error path. A successful stream
 * becomes `{risk, decision, reason?}`, preceded by no reasoning blocks.
 *
 * When the answer carries no safety label, `options.retry` is asked for a
 * second, smaller attempt (see {@link QWEN3GUARD_RETRY_CHARS}). The retry only
 * runs for a delivered answer: a stream that ended in an error or an abort is
 * passed through, because the reviewer deadline is already spent.
 *
 * @param {AsyncIterable<object>} stream
 * @param {{ retry?: () => AsyncIterable<object> }} [options]
 * @returns {AsyncGenerator<object>}
 */
export async function* adaptQwen3GuardStream(stream, options = {}) {
  let attempt = await collectQwen3Guard(stream);
  let attempts = 1;

  if (
    attempt.finish !== undefined &&
    (attempt.finish.reason?.kind === "error" || attempt.finish.reason?.kind === "aborted")
  ) {
    yield attempt.finish;
    return;
  }

  if (!hasSafetyLabel(attempt.text) && typeof options.retry === "function") {
    let retried;
    try {
      retried = await collectQwen3Guard(options.retry());
    } catch {
      retried = undefined;
    }
    if (retried !== undefined) {
      attempts = 2;
      if (
        retried.finish !== undefined &&
        (retried.finish.reason?.kind === "error" ||
          retried.finish.reason?.kind === "aborted")
      ) {
        yield retried.finish;
        return;
      }
      if (hasSafetyLabel(retried.text)) attempt = retried;
    }
  }

  const body = JSON.stringify(qwen3GuardDecision(attempt.text, { attempts }));
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: body };
  yield { type: "block-end", index: 0, block: { type: "text", text: body } };
  if (attempt.usage !== undefined) yield attempt.usage;
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * Attach the reviewer deadline to a request, alongside the caller's signal.
 * @param {object} request
 * @param {object} options
 * @param {{ signal?: unknown }} route
 * @returns {object}
 */
function withRouteSignal(request, options, route) {
  if (!(route.signal instanceof AbortSignal)) return request;
  request.signal =
    options.signal instanceof AbortSignal
      ? AbortSignal.any([options.signal, route.signal])
      : route.signal;
  return request;
}

/**
 * Rewrite an Auto review request to the configured reviewer route.
 *
 * Returns `undefined` when the request should continue down the normal
 * waterfall: it is not a review, the target route is incomplete, it is the
 * re-entered copy created by this function, or nothing would change (same
 * route and no policy addition).
 *
 * Under the JSON protocol the policy prompt is extended with
 * {@link REASON_POLICY_ZH}, which is why a request that already names the
 * configured route is still dispatched: appending the requirement is a change,
 * and "follow the main model" is the case where the shipped policy is used
 * verbatim. Qwen3Guard never sees the policy, so `reasonPolicy` does not apply.
 *
 * @param {object} options - immutable LLM request.
 * @param {{ provider?: unknown, model?: unknown, protocol?: unknown, maxInputChars?: unknown, reasonPolicy?: unknown, signal?: AbortSignal }} route
 *   - configured route; `reasonPolicy: false` keeps the shipped text, `signal`
 *   (the reviewer deadline) also aborts the dispatched request.
 * @param {(request: object) => unknown} dispatch - sends a request to the LLM service.
 * @returns the dispatched stream for a rewritten request, otherwise `undefined`.
 */
export function routeReview(options, route, dispatch) {
  if (rewritten.has(options)) {
    rewritten.delete(options);
    return undefined;
  }

  if (!isReviewRequest(options)) return undefined;

  const provider = String(route.provider ?? "").trim();
  const model = String(route.model ?? "").trim();
  const halfConfigured = (provider === "") !== (model === "");

  if (halfConfigured) {
    // Half a route cannot name a different model, so it follows the main one.
    // The reasoning language is orthogonal to routing and still applies: an
    // English reviewer answer would land in a Chinese approval card.
    if (route.reasonPolicy === false) return undefined;
    const system = withReasonPolicy(options.system);
    const next = system === options.system ? { ...options } : { ...options, system };
    rewritten.add(withRouteSignal(next, options, route));
    return dispatch(next);
  }

  const targetProvider = provider === "" ? options.provider : provider;
  const targetModel = model === "" ? options.model : model;
  if (typeof targetProvider !== "string" || typeof targetModel !== "string") {
    return undefined;
  }
  if (targetProvider === "" || targetModel === "") return undefined;

  const protocol = resolveReviewProtocol(route, targetModel);
  const sameRoute =
    options.provider === targetProvider && options.model === targetModel;

  if (protocol !== "qwen3guard") {
    const system =
      route.reasonPolicy === false ? options.system : withReasonPolicy(options.system);
    if (sameRoute && system === options.system) return undefined;
    const next = {
      ...options,
      provider: targetProvider,
      model: targetModel,
      ...(system === options.system ? {} : { system }),
    };
    rewritten.add(withRouteSignal(next, options, route));
    return dispatch(next);
  }

  const budget = Number(route.maxInputChars ?? 0);
  const next = qwen3GuardRequest(options, targetProvider, targetModel, budget);
  rewritten.add(withRouteSignal(next, options, route));
  const firstText = next.messages[0].content[0].text;

  // The second attempt always changes one variable: if the configured budget
  // already fit the prompt, shrink to the pending call; otherwise shrink the
  // budget. Re-sending an identical prompt measures nothing.
  const retry = () => {
    const retryBudget =
      Number.isFinite(budget) && budget > 0
        ? Math.min(budget, QWEN3GUARD_RETRY_CHARS)
        : QWEN3GUARD_RETRY_CHARS;
    const pendingOnly = firstText.length <= retryBudget;
    const request = qwen3GuardRequest(
      options,
      targetProvider,
      targetModel,
      retryBudget,
      { pendingOnly },
    );
    return dispatch(withRouteSignal(request, options, route));
  };

  return adaptQwen3GuardStream(dispatch(next), { retry });
}
