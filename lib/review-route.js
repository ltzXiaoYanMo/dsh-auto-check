/**
 * Pure routing and protocol adaptation for Auto review requests.
 *
 * The shipped auto-review plugin renders its policy as the request's `system`
 * prompt, and that prompt starts with this exact line. The request carries no
 * session id or other metadata, so the prefix is the only stable marker.
 */
export const REVIEW_POLICY_PREFIX = "REVIEW_POLICY\n";

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
 * Collect the text Auto review sent for the pending tool call.
 * @param {{ messages?: unknown }} options
 * @returns {string}
 */
export function reviewText(options) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const parts = [];
  for (const message of messages) {
    if (typeof message?.content === "string") {
      parts.push(message.content);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n\n");
  return typeof options.messages === "string" ? options.messages : "";
}

const TRUNCATION_MARKER =
  "\n\n[... auto-review input truncated to fit the reviewer context window ...]\n\n";

/**
 * Trim a review prompt while preserving both ends.
 *
 * Auto review renders `ENVIRONMENT`, `PROJECT_INSTRUCTIONS`, `FILTERED_HISTORY`
 * and `PENDING_ACTION` in that order. A 32k-token local model cannot hold a long
 * session's full history, but dropping the tail would also drop the pending
 * tool call that is being judged. Keep the head (environment/instructions) and
 * the tail (recent history and the pending action), and mark the cut.
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
 * Build the request Qwen3Guard expects.
 *
 * Qwen3Guard-Gen uses a fixed chat template for safety classification and does
 * not follow auto-review's JSON policy. Sending the policy as a system message
 * would be classified as part of the content, so only the pending-action text
 * is forwarded as the user turn. The output is short (`Safety:` plus
 * `Categories:`), so 128 tokens is ample.
 *
 * @param {object} options - immutable Auto review request.
 * @param {string} provider
 * @param {string} model
 * @param {number} [maxInputChars] - 0 disables truncation.
 * @returns {object}
 */
export function qwen3GuardRequest(options, provider, model, maxInputChars = 0) {
  const { system: _system, messages: _messages, ...rest } = options;
  const text = truncateReviewText(reviewText(options), maxInputChars);
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

/**
 * Map a Qwen3Guard safety label to auto-review's risk/decision protocol.
 *
 * `Safe` allows. `Unsafe` is high risk and denies. `Controversial` is context
 * dependent; this adapter treats it as medium risk and denies so the user can
 * still decide through auto-review's ask path when the downstream policy
 * allows. A missing label fails closed.
 *
 * @param {string} text
 * @returns {{ risk: "low" | "medium" | "high", decision: "allow" | "deny", reason?: string }}
 */
export function qwen3GuardDecision(text) {
  const label = /Safety:\s*(Safe|Unsafe|Controversial)/i.exec(text)?.[1]?.toLowerCase();
  const categories = /Categories:\s*([^\n]+)/i.exec(text)?.[1]?.trim();
  const detail =
    categories !== undefined && !/^none$/i.test(categories)
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

  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
  return {
    risk: "high",
    decision: "deny",
    reason: snippet === ""
      ? "Qwen3Guard returned no Safety label"
      : `Qwen3Guard returned no Safety label: ${snippet}`,
  };
}

/**
 * Consume Qwen3Guard's native text stream and emit the one-text-block JSON
 * stream auto-review's `readDecision` requires.
 *
 * Adapter errors are passed through as their terminal finish chunk so
 * auto-review keeps its existing fail-closed error path. A successful stream
 * becomes `{risk, decision, reason?}`, preceded by no reasoning blocks.
 *
 * @param {AsyncIterable<object>} stream
 * @returns {AsyncGenerator<object>}
 */
export async function* adaptQwen3GuardStream(stream) {
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

  if (
    finish !== undefined &&
    (finish.reason?.kind === "error" || finish.reason?.kind === "aborted")
  ) {
    yield finish;
    return;
  }

  const body = JSON.stringify(qwen3GuardDecision(text));
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: body };
  yield { type: "block-end", index: 0, block: { type: "text", text: body } };
  if (usage !== undefined) yield usage;
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * Rewrite an Auto review request to the configured reviewer route.
 *
 * Returns `undefined` when the request should continue down the normal
 * waterfall: it is not a review, the target route is incomplete, it already
 * names the configured route under the plain JSON protocol, or it is the
 * re-entered copy created by this function.
 *
 * @param {object} options - immutable LLM request.
 * @param {{ provider?: unknown, model?: unknown, protocol?: unknown }} route - configured route.
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
  if ((provider === "") !== (model === "")) return undefined;
  const targetProvider = provider === "" ? options.provider : provider;
  const targetModel = model === "" ? options.model : model;
  if (typeof targetProvider !== "string" || typeof targetModel !== "string") {
    return undefined;
  }
  if (targetProvider === "" || targetModel === "") return undefined;

  const protocol = resolveReviewProtocol(route, targetModel);
  const sameRoute =
    options.provider === targetProvider && options.model === targetModel;
  if (protocol === "json" && sameRoute) return undefined;

  const next =
    protocol === "qwen3guard"
      ? qwen3GuardRequest(
          options,
          targetProvider,
          targetModel,
          Number(route.maxInputChars ?? 0),
        )
      : { ...options, provider: targetProvider, model: targetModel };
  rewritten.add(next);
  const stream = dispatch(next);
  return protocol === "qwen3guard" ? adaptQwen3GuardStream(stream) : stream;
}
