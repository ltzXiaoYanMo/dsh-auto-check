import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptQwen3GuardStream,
  isReviewRequest,
  qwen3GuardDecision,
  qwen3GuardRequest,
  resolveReviewProtocol,
  routeReview,
  REVIEW_POLICY_PREFIX,
} from "../lib/review-route.js";

const policy = `${REVIEW_POLICY_PREFIX}You are the Auto review policy.`;
const normal = Object.freeze({
  provider: "main-provider",
  model: "main-model",
  system: "You are a coding agent.",
  messages: [],
});

test("recognises only the Auto review policy prompt", () => {
  assert.equal(isReviewRequest(normal), false);
  assert.equal(isReviewRequest({ system: undefined }), false);
  assert.equal(isReviewRequest({ system: "REVIEW_POLICY" }), false);
  assert.equal(isReviewRequest({ system: policy }), true);
});

test("a normal request passes through untouched", () => {
  let dispatched = 0;
  const result = routeReview(normal, { provider: "cheap", model: "mini" }, () => {
    dispatched += 1;
  });
  assert.equal(result, undefined);
  assert.equal(dispatched, 0);
});

test("a review request is dispatched to the configured route", () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [],
    temperature: 0,
  });
  let received;
  const result = routeReview(
    request,
    { provider: " cheap ", model: " mini " },
    (next) => {
      received = next;
      return "stream";
    },
  );
  assert.equal(result, "stream");
  assert.deepEqual(received, {
    provider: "cheap",
    model: "mini",
    system: policy,
    messages: [],
    temperature: 0,
  });
  assert.notEqual(received, request);
  assert.equal(request.provider, "main-provider", "frozen request is not mutated");
});

test("the re-entered copy passes through to the adapter", () => {
  const route = { provider: "cheap", model: "mini" };
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [],
  });
  let nested;
  let outerNext = 0;

  // Mirrors the listener in lib/index.js.
  const listener = (options, next) =>
    routeReview(options, route, (rewrittenOptions) => {
      nested = rewrittenOptions;
      return listener(rewrittenOptions, () => "adapter");
    }) ?? next();

  assert.equal(listener(request, () => (outerNext += 1)), "adapter");
  assert.equal(nested.provider, "cheap");
  assert.equal(nested.model, "mini");
  assert.equal(outerNext, 0);
});

test("an incomplete or identical route follows the main model", () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [],
  });
  for (const route of [
    { provider: "", model: "" },
    { provider: "cheap", model: "" },
    { provider: "", model: "mini" },
    { provider: "  ", model: "mini" },
  ]) {
    let dispatched = 0;
    assert.equal(routeReview(request, route, () => (dispatched += 1)), undefined);
    assert.equal(dispatched, 0);
  }

  let dispatched = 0;
  assert.equal(
    routeReview(request, { provider: "main-provider", model: "main-model" }, () => {
      dispatched += 1;
    }),
    undefined,
  );
  assert.equal(dispatched, 0);
});

test("Qwen3Guard protocol is auto-detected from the target model", () => {
  assert.equal(
    resolveReviewProtocol({ protocol: "auto" }, "Qwen/Qwen3Guard-Gen-4B"),
    "qwen3guard",
  );
  assert.equal(
    resolveReviewProtocol({ protocol: "auto" }, "deepseek-v4-flash"),
    "json",
  );
  assert.equal(
    resolveReviewProtocol({ protocol: "qwen3guard" }, "local-guard"),
    "qwen3guard",
  );
  assert.equal(
    resolveReviewProtocol({ protocol: "json" }, "Qwen/Qwen3Guard-Gen-4B"),
    "json",
  );
});

test("the Qwen3Guard request drops the JSON policy and forwards review text", () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Tool: bash\nCommand: rm -rf /tmp/x" }],
      },
    ],
    temperature: 0,
  });
  const next = qwen3GuardRequest(
    request,
    "guard-provider",
    "Qwen/Qwen3Guard-Gen-4B",
  );
  assert.equal(next.provider, "guard-provider");
  assert.equal(next.model, "Qwen/Qwen3Guard-Gen-4B");
  assert.equal(Object.hasOwn(next, "system"), false);
  assert.deepEqual(next.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "Tool: bash\nCommand: rm -rf /tmp/x" }],
    },
  ]);
  assert.equal(next.maxTokens, 128);
  assert.equal(next.temperature, 0);
  assert.equal(request.system, policy, "frozen request is not mutated");
});

test("Qwen3Guard labels map to the auto-review decision protocol", () => {
  assert.deepEqual(qwen3GuardDecision("Safety: Safe\nCategories: None"), {
    risk: "low",
    decision: "allow",
  });
  assert.deepEqual(
    qwen3GuardDecision("Safety: Controversial\nCategories: Politically Sensitive Topics"),
    {
      risk: "medium",
      decision: "deny",
      reason: "Qwen3Guard: Controversial (categories: Politically Sensitive Topics)",
    },
  );
  assert.deepEqual(
    qwen3GuardDecision("Safety: Unsafe\nCategories: Violent"),
    {
      risk: "high",
      decision: "deny",
      reason: "Qwen3Guard: Unsafe (categories: Violent)",
    },
  );
  assert.equal(qwen3GuardDecision("I cannot classify this").decision, "deny");
  assert.equal(qwen3GuardDecision("I cannot classify this").risk, "high");
});

test("the Qwen3Guard stream is replaced by one JSON text block", async () => {
  async function* native() {
    yield { type: "text-delta", index: 0, text: "Safety: Unsafe\n" };
    yield { type: "text-delta", index: 0, text: "Categories: Violent" };
    yield {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  const chunks = [];
  for await (const chunk of adaptQwen3GuardStream(native())) chunks.push(chunk);
  assert.deepEqual(chunks[0], {
    type: "block-start",
    index: 0,
    blockType: "text",
  });
  assert.deepEqual(JSON.parse(chunks[1].text), {
    risk: "high",
    decision: "deny",
    reason: "Qwen3Guard: Unsafe (categories: Violent)",
  });
  assert.deepEqual(chunks[2], {
    type: "block-end",
    index: 0,
    block: { type: "text", text: chunks[1].text },
  });
  assert.equal(chunks[3].type, "usage");
  assert.deepEqual(chunks[4], { type: "finish", reason: { kind: "stop" } });
});

test("a Qwen3Guard route adapts even when it equals the main model", async () => {
  const request = Object.freeze({
    provider: "guard-provider",
    model: "Qwen/Qwen3Guard-Gen-4B",
    system: policy,
    messages: [
      { role: "user", content: [{ type: "text", text: "write a harmless hello" }] },
    ],
    temperature: 0,
  });
  async function* native() {
    yield { type: "text-delta", index: 0, text: "Safety: Safe\nCategories: None" };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  let received;
  const result = routeReview(
    request,
    {
      provider: "guard-provider",
      model: "Qwen/Qwen3Guard-Gen-4B",
      protocol: "auto",
    },
    (next) => {
      received = next;
      return native();
    },
  );

  assert.equal(Object.hasOwn(received, "system"), false);
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.deepEqual(JSON.parse(chunks[1].text), {
    risk: "low",
    decision: "allow",
  });
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});
