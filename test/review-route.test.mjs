import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptQwen3GuardStream,
  fitReviewTexts,
  isReviewRequest,
  qwen3GuardDecision,
  qwen3GuardRequest,
  resolveReviewProtocol,
  routeReview,
  withReasonPolicy,
  NO_LABEL_REASON,
  NO_LABEL_RETRIED_REASON,
  QWEN3GUARD_RETRY_CHARS,
  REVIEW_POLICY_PREFIX,
  REASON_POLICY_MARKER,
  truncateReviewText,
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
    system: withReasonPolicy(policy),
    messages: [],
    temperature: 0,
  });
  assert.notEqual(received, request);
  assert.equal(request.provider, "main-provider", "frozen request is not mutated");
  assert.equal(request.system, policy, "frozen request keeps the shipped policy");
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

test("an incomplete route keeps the main model but still takes the reasoning policy", () => {
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
    let received;
    routeReview(request, route, (next) => {
      received = next;
    });
    assert.equal(received.provider, "main-provider", JSON.stringify(route));
    assert.equal(received.model, "main-model", JSON.stringify(route));
    assert.equal(received.system, withReasonPolicy(policy));
  }

  // With the option off an incomplete route is a pure pass-through again.
  let dispatched = 0;
  assert.equal(
    routeReview(request, { provider: "", model: "", reasonPolicy: false }, () => (dispatched += 1)),
    undefined,
  );
  assert.equal(dispatched, 0);
});

test("the identical route still takes the reasoning policy", () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [],
  });
  const route = { provider: "main-provider", model: "main-model" };
  let received;
  routeReview(request, route, (next) => {
    received = next;
  });
  assert.equal(received.system, withReasonPolicy(policy));

  // Once the policy is there, a re-entered copy is left alone.
  let again = 0;
  routeReview(received, route, () => (again += 1));
  assert.equal(again, 0);

  // Turning the option off restores the shipped behaviour.
  let off = 0;
  assert.equal(
    routeReview(request, { ...route, reasonPolicy: false }, () => (off += 1)),
    undefined,
  );
  assert.equal(off, 0);
});

test("the reasoning policy is appended once, after the shipped policy", () => {
  assert.equal(withReasonPolicy("You are a coding agent."), "You are a coding agent.");
  assert.equal(withReasonPolicy(undefined), undefined);

  const once = withReasonPolicy(policy);
  assert.ok(once.startsWith(policy), "the shipped policy stays first");
  assert.match(once, new RegExp(REASON_POLICY_MARKER));
  assert.equal(withReasonPolicy(once), once, "idempotent");

  const addendum = once.slice(policy.length);
  assert.match(addendum, /简体中文/);
  assert.match(addendum, /这次操作会做什么/);
  assert.match(addendum, /为什么拒绝/);
  assert.match(addendum, /Every deny object must carry reason/);
  // The addendum must not smuggle a new JSON shape into the prompt: the host
  // counts the members of the returned object.
  assert.doesNotMatch(addendum, /\{"risk"/);
  assert.doesNotMatch(addendum, /"reason":\s*"/);
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
    store: false,
  });
  const next = qwen3GuardRequest(
    request,
    "guard-provider",
    "Qwen/Qwen3Guard-Gen-4B",
  );
  assert.equal(next.provider, "guard-provider");
  assert.equal(next.model, "Qwen/Qwen3Guard-Gen-4B");
  assert.equal(Object.hasOwn(next, "system"), false);
  assert.equal(Object.hasOwn(next, "store"), false);
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

test("long review text is truncated from the middle, keeping both ends", () => {
  const text = "HEAD-" + "x".repeat(500) + "-TAIL";
  const short = truncateReviewText(text, 200);
  assert.equal(short.length, 200);
  assert.equal(short.startsWith("HEAD-"), true);
  assert.equal(short.endsWith("-TAIL"), true);
  assert.equal(short.includes("truncated"), true);
  assert.equal(truncateReviewText("short", 200), "short");
  assert.equal(truncateReviewText("short", 0), "short");
});

test("the Qwen3Guard request applies the configured character budget", () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "A".repeat(500) + "PENDING" }],
      },
    ],
  });
  const next = qwen3GuardRequest(
    request,
    "guard-provider",
    "Qwen/Qwen3Guard-Gen-4B",
    120,
  );
  const text = next.messages[0].content[0].text;
  assert.equal(text.length, 120);
  assert.equal(text.endsWith("PENDING"), true);
  assert.equal(text.includes("truncated"), true);
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

test("a degenerate answer becomes a readable rejection, never raw tokens", async () => {
  const garbage = "</endoftext>" + " </BEG>".repeat(60);
  async function* native() {
    yield { type: "text-delta", index: 0, text: garbage };
    yield { type: "finish", reason: { kind: "stop" } };
  }

  const chunks = [];
  for await (const chunk of adaptQwen3GuardStream(native())) chunks.push(chunk);
  const decision = JSON.parse(chunks[1].text);
  assert.equal(decision.risk, "high");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, NO_LABEL_REASON);
  assert.doesNotMatch(decision.reason, /BEG|endoftext/);
  assert.ok(decision.reason.length < 200);
});

test("an unlabelled answer is retried on a smaller prompt and its label is used", async () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [
      { role: "user", content: [{ type: "text", text: 'ENVIRONMENT\n{"cwd":"C:\\\\w"}' }] },
      { role: "user", content: [{ type: "text", text: "earlier history ".repeat(1200) }] },
      { role: "user", content: [{ type: "text", text: "PENDING Remove-Item -Recurse -Force .\\tmp" }] },
    ],
  });

  const seen = [];
  const streams = [
    async function* () {
      yield { type: "text-delta", index: 0, text: "the user is asking about" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
    async function* () {
      yield { type: "text-delta", index: 0, text: "Safety: Safe\nCategories: None" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  ];
  const result = routeReview(
    request,
    { provider: "guard", model: "Qwen3Guard-Gen-4B", maxInputChars: 24000 },
    (next) => {
      seen.push(next);
      return streams[seen.length - 1]();
    },
  );

  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(seen.length, 2, "the first answer had no label, so one retry runs");
  const retried = seen[1].messages[0].content[0].text;
  assert.ok(retried.length <= QWEN3GUARD_RETRY_CHARS, "the retry shrinks the prompt");
  assert.ok(retried.length < seen[0].messages[0].content[0].text.length);
  assert.deepEqual(JSON.parse(chunks[1].text), { risk: "low", decision: "allow" });
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

test("a retry that also fails says so instead of quoting the model", async () => {
  const request = Object.freeze({
    provider: "main-provider",
    model: "main-model",
    system: policy,
    messages: [{ role: "user", content: [{ type: "text", text: "ENVIRONMENT\n{}" }] }],
  });
  const garbage = () =>
    (async function* () {
      yield { type: "text-delta", index: 0, text: "</BEG>".repeat(20) };
      yield { type: "finish", reason: { kind: "stop" } };
    })();

  const result = routeReview(
    request,
    { provider: "guard", model: "Qwen3Guard-Gen-4B" },
    () => garbage(),
  );
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  const decision = JSON.parse(chunks[1].text);
  assert.equal(decision.reason, NO_LABEL_RETRIED_REASON);
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

test("fitReviewTexts keeps the environment and the pending call, drops old history", () => {
  const env = 'ENVIRONMENT\n{"cwd":"C:\\\\w"}';
  const pending = "PENDING " + "p".repeat(200);
  const parts = [env, "h1 ".repeat(200), "h2 ".repeat(200), "h3 ".repeat(200), pending];

  const fitted = fitReviewTexts(parts, 1200);
  assert.ok(fitted.length <= 1200, "result stays inside the budget");
  assert.ok(fitted.startsWith(env), "the environment header survives");
  assert.ok(fitted.endsWith(pending), "the pending call survives intact");
  assert.match(fitted, /earlier history message\(s\) dropped/);
  assert.doesNotMatch(fitted, /h1/);
});
