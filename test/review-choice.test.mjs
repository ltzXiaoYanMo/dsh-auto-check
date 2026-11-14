import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ALLOW_ONCE_LABEL,
  AUTO_REVIEW_DENIED_CODE,
  KEEP_DENIED_LABEL,
  REVIEW_CHOICE_QUESTION_ID,
  REVIEWER_TIMEOUT_CODE,
  collapseReason,
  createReviewChoiceListener,
  describeArguments,
  foldReason,
  formatArguments,
  isReviewDenial,
  keepOutermost,
  qwen3GuardVerdict,
  resolveChoice,
  reviewDenialKind,
  reviewQuestion,
  withReviewDeadline,
} from "../lib/review-choice.js";
import { routeReview, REVIEW_POLICY_PREFIX } from "../lib/review-route.js";

// Literal copies of dsh-experimental-auto-review denied(), failed(), askUser().
const exec = Object.freeze({ name: "bash", agent: { session: { id: "s" } } });
const deniedGate = {
  kind: "deny",
  reason: 'Auto review rejected tool "bash"; its body was not executed',
  info: {
    name: "AutoReviewDeniedError",
    code: "AUTO_REVIEW_DENIED",
    reason: "Qwen3Guard: Controversial (categories: Violent)",
  },
};
const failedGate = {
  kind: "deny",
  reason:
    'Auto review of tool "bash" failed; its body was not executed: auto-review: reviewer ended with error REVIEWER_TIMEOUT: reviewer did not finish within 10 ms',
};
const askGate = {
  kind: "ask",
  reason: 'Auto review denied tool "bash": Qwen3Guard: Unsafe (no category)',
  displayReason: {
    en: "Auto review denied this call: Qwen3Guard: Unsafe (no category)",
    zh: "Auto review 拒绝了此调用：Qwen3Guard: Unsafe (no category)",
  },
};

function answerWith(...selected) {
  return { answers: [{ id: REVIEW_CHOICE_QUESTION_ID, selected }] };
}

test("recognises the three Auto review gate shapes", () => {
  assert.equal(AUTO_REVIEW_DENIED_CODE, "AUTO_REVIEW_DENIED");
  assert.equal(reviewDenialKind(deniedGate), "denied");
  assert.equal(reviewDenialKind(failedGate), "failed");
  assert.equal(reviewDenialKind(askGate), "ask");
  for (const gate of [deniedGate, failedGate, askGate]) {
    assert.equal(isReviewDenial(gate), true);
  }
});

test("ignores unrelated gate results", () => {
  for (const gate of [
    { kind: "allow" },
    { kind: "cancel" },
    { kind: "deny", reason: 'the user rejected tool "bash"' },
    { kind: "deny", reason: "sandbox", info: { code: "OTHER" } },
    { kind: "ask", reason: "plan mode wants approval" },
    undefined,
    null,
    "deny",
  ]) {
    assert.equal(isReviewDenial(gate), false, JSON.stringify(gate));
  }
});

test("the question shows the tool and reviewer reason, keep-denied first", () => {
  const signal = new AbortController().signal;
  const request = reviewQuestion(exec, deniedGate, signal);
  assert.equal(request.agent, exec.agent);
  assert.equal(request.signal, signal);
  assert.equal(request.questions.length, 1);
  const [question] = request.questions;
  assert.equal(question.id, REVIEW_CHOICE_QUESTION_ID);
  assert.equal(question.intent, undefined, "no intent avoids BAD_INTENT");
  assert.match(question.detail, /`bash`/);
  assert.match(question.detail, /Safety: Controversial/);
  assert.match(question.detail, /Categories: Violent/);
  assert.deepEqual(
    question.options.map((option) => option.label),
    [KEEP_DENIED_LABEL, ALLOW_ONCE_LABEL],
  );
  // The client only shows the badge and preselects when options[0] has the suffix.
  assert.match(question.options[0].label, /\s*\((?:recommended|推荐)\)\s*$/i);
  assert.doesNotMatch(question.options[1].label, /\((?:recommended|推荐)\)\s*$/i);

  assert.match(reviewQuestion(exec, failedGate).questions[0].detail, /REVIEWER_TIMEOUT/);
  assert.match(reviewQuestion(exec, failedGate).questions[0].detail, /没有响应/);
  const askDetail = reviewQuestion(exec, askGate).questions[0].detail;
  assert.match(askDetail, /Safety: Unsafe/);
  assert.match(askDetail, /Categories: None/);
  assert.doesNotMatch(askDetail, /Auto review 拒绝了此调用：/, "the host wrapper is stripped");
  assert.doesNotMatch(askDetail, /Auto review denied this call:/, "the English half is dropped");
});

test("the question shows formatted tool arguments", () => {
  const withArgs = { ...exec, arguments: { command: "rm -rf /tmp/x && echo ```", timeout: 5 } };
  const detail = reviewQuestion(withArgs, deniedGate).questions[0].detail;
  assert.match(detail, /\*\*Command \/ 命令:\*\*/);
  assert.match(detail, /````sh\nrm -rf \/tmp\/x && echo ```\n````/);
  assert.match(detail, /\*\*Arguments \/ 参数:\*\*/);
  assert.match(detail, /```json\n\{\n  "timeout": 5\n\}\n```/);
  const bare = reviewQuestion(exec, deniedGate).questions[0].detail;
  assert.doesNotMatch(bare, /Command \/ 命令/);
  assert.doesNotMatch(bare, /Arguments \/ 参数/);
});

test("formatArguments handles strings, JSON strings and long input", () => {
  assert.equal(formatArguments(undefined), "");
  assert.equal(formatArguments({}), "");
  assert.equal(formatArguments("  "), "");
  assert.equal(formatArguments('{"command":"ls"}'), "```sh\nls\n```");
  assert.equal(formatArguments("not json"), "```\nnot json\n```");
  assert.equal(formatArguments({ path: "a.txt" }), '```json\n{\n  "path": "a.txt"\n}\n```');

  // The command is what the user authorises: it is never clipped.
  const command = "x".repeat(5000);
  const longCommand = formatArguments({ command });
  assert.equal(longCommand, `\`\`\`sh\n${command}\n\`\`\``);

  // Other arguments still are.
  const longRest = formatArguments({ command: "ls", note: "y".repeat(5000) });
  assert.match(longRest, /^```sh\nls\n```/);
  assert.match(longRest, /\(\d+ more chars \/ 另有 \d+ 个字符未显示\)/);
  assert.ok(longRest.length < 4200);
});

test("describeArguments splits the command from the rest", () => {
  assert.deepEqual(describeArguments(undefined), {});
  assert.deepEqual(describeArguments({}), {});
  assert.deepEqual(describeArguments({ command: "ls" }), { command: "```sh\nls\n```" });
  assert.deepEqual(describeArguments({ script: "print(1)" }), {
    command: "```sh\nprint(1)\n```",
  });
  assert.deepEqual(describeArguments({ cmd: "dir", cwd: "C:\\" }), {
    command: "```sh\ndir\n```",
    rest: '```json\n{\n  "cwd": "C:\\\\"\n}\n```',
  });
  assert.deepEqual(describeArguments({ path: "a.txt" }), {
    rest: '```json\n{\n  "path": "a.txt"\n}\n```',
  });
  assert.deepEqual(describeArguments(["a", "b"]), {
    rest: '```json\n[\n  "a",\n  "b"\n]\n```',
  });
  assert.deepEqual(describeArguments("plain text"), { command: "```\nplain text\n```" });
  assert.deepEqual(describeArguments('{"command":"ls"}'), { command: "```sh\nls\n```" });
});

test("collapseReason keeps one language of a duplicated host message", () => {
  assert.equal(collapseReason(undefined), "");
  assert.equal(collapseReason("  "), "");
  assert.equal(
    collapseReason(
      "Auto review denied this call: nope\n\nAuto review 拒绝了此调用：nope",
    ),
    "Auto review 拒绝了此调用：nope",
  );
  // Distinct halves are both kept: they are not the same message.
  assert.equal(
    collapseReason("Auto review denied this call: a\n\nAuto review 拒绝了此调用：b"),
    "Auto review denied this call: a\n\nAuto review 拒绝了此调用：b",
  );
  assert.equal(
    collapseReason("line with trailing space   \n\n\n\nnext"),
    "line with trailing space\n\nnext",
  );
});

test("foldReason bounds reviewer text and says how much was folded", () => {
  const short = "a".repeat(100);
  assert.equal(foldReason(short), short);
  const long = "H".repeat(600) + "M".repeat(600) + "T".repeat(600);
  const folded = foldReason(long);
  assert.ok(folded.length <= 1200 + 80, `length ${folded.length}`);
  assert.match(folded, /折叠/);
  assert.match(folded, /^H/, "the head survives");
  assert.match(folded, /T$/, "the tail survives: gateways put the error code there");
  assert.equal(foldReason(long, 100).length <= 180, true);
});

test("qwen3GuardVerdict extracts the label block", () => {
  assert.deepEqual(qwen3GuardVerdict("Qwen3Guard: Unsafe (categories: Violent, PII)"), {
    verdict: "Safety: Unsafe\nCategories: Violent, PII",
    remainder: "",
  });
  assert.deepEqual(qwen3GuardVerdict("Qwen3Guard: safe (no category)"), {
    verdict: "Safety: Safe\nCategories: None",
    remainder: "",
  });
  assert.deepEqual(
    qwen3GuardVerdict("Auto review 拒绝了此调用：Qwen3Guard: Controversial (categories: Other) — 需要你确认"),
    {
      verdict: "Safety: Controversial\nCategories: Other",
      remainder: "需要你确认",
    },
  );
  assert.deepEqual(qwen3GuardVerdict("Qwen3Guard returned no Safety label: weird payload"), {
    verdict: "Safety: (no label returned)\nCategories: (unknown)",
    remainder: "weird payload",
  });
  assert.equal(qwen3GuardVerdict("Auto review rejected tool \"bash\""), undefined);
  assert.equal(qwen3GuardVerdict(undefined), undefined);
});

test("a Qwen3Guard verdict renders as one fenced block, not prose", () => {
  const detail = reviewQuestion(exec, askGate).questions[0].detail;
  assert.match(detail, /\*\*Verdict \/ 审查结论:\*\*\n\n```\nSafety: Unsafe\nCategories: None\n```/);
  // No remainder, so no note section is appended.
  assert.doesNotMatch(detail, /Note \/ 补充说明/);
  // A plain JSON denial has no verdict section at all.
  assert.doesNotMatch(
    reviewQuestion(exec, { ...deniedGate, info: { ...deniedGate.info, reason: "too risky" } })
      .questions[0].detail,
    /Verdict \/ 审查结论/,
  );
  // A failed reviewer shows its error, never a verdict block.
  const failed = reviewQuestion(exec, failedGate).questions[0].detail;
  assert.doesNotMatch(failed, /Verdict \/ 审查结论/);
  assert.match(failed, /\*\*Reason \/ 原因:\*\*/);
});

test("a huge reviewer reason is folded, and the command survives intact", () => {
  const command = `rm -rf /tmp/x && echo ${"v".repeat(3000)}`;
  const gate = {
    kind: "deny",
    reason: `Auto review rejected tool "bash"; its body was not executed`,
    info: {
      code: "AUTO_REVIEW_DENIED",
      reason: `${"L".repeat(4000)}\n\n[the end of the reviewer text]`,
    },
  };
  const detail = reviewQuestion({ ...exec, arguments: { command } }, gate).questions[0].detail;
  assert.ok(detail.length < 7000, `detail length ${detail.length}`);
  assert.match(detail, /已折叠/, "the folded span is reported");
  assert.match(detail, /\[the end of the reviewer text\]/, "the tail survives");
  assert.ok(detail.includes(command), "the command is never truncated");
});

test("only the explicit allow option allows", () => {
  assert.equal(resolveChoice(answerWith(ALLOW_ONCE_LABEL)), "allow");
  assert.equal(resolveChoice(answerWith(KEEP_DENIED_LABEL)), "deny");
  assert.equal(resolveChoice(answerWith()), "deny", "skipped");
  assert.equal(resolveChoice(answerWith("something else")), "deny");
  assert.equal(resolveChoice(answerWith(ALLOW_ONCE_LABEL, KEEP_DENIED_LABEL)), "deny");
  assert.equal(
    resolveChoice({ answers: [{ id: REVIEW_CHOICE_QUESTION_ID, selected: [], custom: "allow it" }] }),
    "deny",
    "custom text never allows",
  );
  assert.equal(resolveChoice(undefined), "deny");
  assert.equal(resolveChoice({}), "deny");
  assert.equal(resolveChoice({ answers: [{ id: "other", selected: [ALLOW_ONCE_LABEL] }, {}] }), "deny");
});

function listenerWith({ onBlock = "ask", ask, policy = "never", questions = true } = {}) {
  const asked = [];
  const listener = createReviewChoiceListener({
    onBlock: () => onBlock,
    userQuestions: () =>
      questions
        ? {
            ask: async (request) => {
              asked.push(request);
              return ask(request);
            },
          }
        : undefined,
    approval: () => ({ effectivePolicy: () => policy }),
  });
  return { listener, asked };
}

test("a denial becomes a question; allow-once allows", async () => {
  for (const gate of [deniedGate, failedGate, askGate]) {
    const { listener, asked } = listenerWith({ ask: () => answerWith(ALLOW_ONCE_LABEL) });
    assert.deepEqual(await listener(exec, async () => gate), { kind: "allow" });
    assert.equal(asked.length, 1);
  }
});

test("keep-denied returns the original gate", async () => {
  for (const gate of [deniedGate, failedGate, askGate]) {
    const { listener } = listenerWith({ ask: () => answerWith(KEEP_DENIED_LABEL) });
    assert.equal(await listener(exec, async () => gate), gate);
  }
});

test("fail closed: every ask failure keeps the original denial", async () => {
  const failures = ["NO_PROVIDER", "ASK_CANCELLED", "ASK_ABORTED", "CALLER_NOT_LIVE"].map(
    (code) => () => {
      throw Object.assign(new Error(code), { code });
    },
  );
  failures.push(() => undefined, () => ({ answers: [] }), () => answerWith());
  for (const ask of failures) {
    for (const gate of [deniedGate, failedGate, askGate]) {
      const { listener } = listenerWith({ ask });
      assert.equal(await listener(exec, async () => gate), gate);
    }
  }
});

test("an abort during the prompt keeps the denial even if an answer arrives", async () => {
  const controller = new AbortController();
  const { listener } = listenerWith({
    ask: () => {
      controller.abort();
      return answerWith(ALLOW_ONCE_LABEL);
    },
  });
  const aborting = { ...exec, signal: controller.signal };
  assert.equal(await listener(aborting, async () => deniedGate), deniedGate);
});

test("passes through when it cannot or must not ask", async () => {
  const ask = () => answerWith(ALLOW_ONCE_LABEL);
  // onBlock: deny keeps the shipped behaviour.
  let probe = listenerWith({ onBlock: "deny", ask });
  assert.equal(await probe.listener(exec, async () => deniedGate), deniedGate);
  assert.equal(probe.asked.length, 0);
  // No userQuestions service.
  probe = listenerWith({ questions: false, ask });
  assert.equal(await probe.listener(exec, async () => failedGate), failedGate);
  // No agent: nobody to ask.
  probe = listenerWith({ ask });
  assert.equal(await probe.listener({ name: "bash" }, async () => deniedGate), deniedGate);
  assert.equal(probe.asked.length, 0);
  // `ask` under the `ask` policy: the approval card already asks the user.
  probe = listenerWith({ policy: "ask", ask });
  assert.equal(await probe.listener(exec, async () => askGate), askGate);
  assert.equal(probe.asked.length, 0);
  // Unrelated results are untouched.
  probe = listenerWith({ ask });
  const other = { kind: "deny", reason: "sandbox" };
  assert.equal(await probe.listener(exec, async () => other), other);
  assert.deepEqual(await probe.listener(exec, async () => ({ kind: "allow" })), { kind: "allow" });
  assert.equal(probe.asked.length, 0);
});

// --- reviewer deadline ---------------------------------------------------

/** The exact readDecision finish handling from dsh-experimental-auto-review. */
async function readFinish(stream) {
  let finished = false;
  for await (const chunk of stream) {
    if (finished) throw new Error("auto-review: reviewer emitted data after its terminal finish");
    if (chunk.type === "finish") {
      finished = true;
      if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
        const { code, message } = chunk.reason.failure;
        throw new Error(`auto-review: reviewer ended with ${chunk.reason.kind} ${code}: ${message}`);
      }
      if (chunk.reason.kind !== "stop") throw new Error(`auto-review: reviewer ended with ${chunk.reason.kind}`);
    }
  }
  if (!finished) throw new Error("auto-review: reviewer emitted no terminal finish");
  return "ok";
}

async function* normalStream() {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: "{}" };
  yield { type: "finish", reason: { kind: "stop" } };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function stuckStream() {
  let returned = false;
  const stream = {
    get returned() {
      return returned;
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return stream;
}

test("a normal reviewer stream passes through unchanged", async () => {
  assert.deepEqual(await collect(withReviewDeadline(normalStream(), 1000)), await collect(normalStream()));
  assert.deepEqual(await collect(withReviewDeadline(normalStream(), 0)), await collect(normalStream()));
});

test("a stuck reviewer stream ends with a synthetic REVIEWER_TIMEOUT finish", async () => {
  const stuck = stuckStream();
  let aborted = 0;
  const chunks = await collect(withReviewDeadline(stuck, 10, () => (aborted += 1)));
  assert.deepEqual(chunks, [
    {
      type: "finish",
      reason: {
        kind: "error",
        failure: { code: REVIEWER_TIMEOUT_CODE, message: "reviewer did not finish within 10 ms" },
      },
    },
  ]);
  assert.equal(aborted, 1, "the underlying request is aborted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stuck.returned, true, "the underlying iterator is released");

  // readDecision turns it into the error failed() wraps, which the choice
  // listener matches as a "failed" gate.
  await assert.rejects(
    readFinish(withReviewDeadline(stuckStream(), 10)),
    /^Error: auto-review: reviewer ended with error REVIEWER_TIMEOUT: reviewer did not finish within 10 ms$/,
  );
  const gate = {
    kind: "deny",
    reason: `Auto review of tool "bash" failed; its body was not executed: auto-review: reviewer ended with error REVIEWER_TIMEOUT: x`,
  };
  assert.equal(reviewDenialKind(gate), "failed");
});

test("timeout 0 disables the deadline", async () => {
  const stuck = stuckStream();
  const iterator = withReviewDeadline(stuck, 0)[Symbol.asyncIterator]();
  const winner = await Promise.race([
    iterator.next().then(() => "chunk"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 30)),
  ]);
  assert.equal(winner, "still waiting");
});

test("the deadline stops counting after the real finish", async () => {
  async function* slowTail() {
    yield { type: "finish", reason: { kind: "stop" } };
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const chunks = await collect(withReviewDeadline(slowTail(), 10));
  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "stop" } }]);
});

test("routeReview forwards the deadline signal to the dispatched request", () => {
  const caller = new AbortController();
  const deadline = new AbortController();
  const request = Object.freeze({
    provider: "main",
    model: "main",
    system: `${REVIEW_POLICY_PREFIX}policy`,
    messages: [],
    signal: caller.signal,
  });
  let received;
  routeReview(request, { provider: "p", model: "Qwen3Guard-Gen-4B", signal: deadline.signal }, (next) => {
    received = next;
    return normalStream();
  });
  assert.equal(received.signal.aborted, false);
  deadline.abort();
  assert.equal(received.signal.aborted, true);
});

// --- waterfall order -----------------------------------------------------

/** Minimal cordis-like bus: prepend = unshift, waterfall runs index 0 first. */
function fakeBus() {
  const hooks = {};
  const bus = {
    on(name, callback, options = {}) {
      const list = (hooks[name] ??= []);
      const result = bus.bail("internal/listener", name, callback, options);
      if (result) return result;
      const record = { callback };
      list[options.prepend ? "unshift" : "push"](record);
      return () => {
        const index = list.indexOf(record);
        if (index >= 0) list.splice(index, 1);
      };
    },
    bail(name, ...args) {
      for (const { callback } of hooks[name] ?? []) {
        const result = callback(...args);
        if (result) return result;
      }
      return undefined;
    },
    waterfall(name, arg, inner) {
      const cbs = [...(hooks[name] ?? [])].map((hook) => hook.callback);
      const next = () => (cbs.shift() ?? inner)(arg, next);
      return next();
    },
  };
  return bus;
}

const gateListener = async () => deniedGate;

test("keepOutermost wraps a gate registered later (fake bus)", async () => {
  const bus = fakeBus();
  const { listener } = listenerWith({ ask: () => answerWith(ALLOW_ONCE_LABEL) });
  keepOutermost(bus, "tools/pre-execute", listener);
  bus.on("tools/pre-execute", gateListener, { prepend: true });
  await Promise.resolve();
  assert.deepEqual(
    await bus.waterfall("tools/pre-execute", exec, async () => ({ kind: "allow" })),
    { kind: "allow" },
  );
});

test("without keepOutermost a later gate would hide its denial (fake bus)", async () => {
  const bus = fakeBus();
  const { listener, asked } = listenerWith({ ask: () => answerWith(ALLOW_ONCE_LABEL) });
  bus.on("tools/pre-execute", listener, { prepend: true });
  bus.on("tools/pre-execute", gateListener, { prepend: true });
  assert.equal(await bus.waterfall("tools/pre-execute", exec, async () => ({ kind: "allow" })), deniedGate);
  assert.equal(asked.length, 0);
});

const HOST_CORDIS =
  "C:/Program Files/DSH Desktop Beta/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js";

test(
  "keepOutermost wraps the gate in real cordis, in both load orders",
  { skip: existsSync(HOST_CORDIS) ? false : "host cordis checkout not found" },
  async () => {
    const { Context } = await import(pathToFileURL(HOST_CORDIS).href);
    for (const gateFirst of [true, false]) {
      const root = new Context();
      const { listener, asked } = listenerWith({ ask: () => answerWith(ALLOW_ONCE_LABEL) });
      const ours = {
        apply(ctx) {
          ctx.effect(() => keepOutermost(ctx, "tools/pre-execute", listener));
        },
      };
      // Same registration as dsh-experimental-auto-review apply().
      const gate = {
        apply(ctx) {
          ctx.effect(function* () {
            yield ctx.on("tools/pre-execute", gateListener, { prepend: true });
          });
        },
      };
      for (const plugin of gateFirst ? [gate, ours] : [ours, gate]) await root.plugin(plugin);
      await Promise.resolve();
      const result = await root.waterfall("tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
      assert.deepEqual(result, { kind: "allow" }, `gateFirst=${gateFirst}`);
      assert.equal(asked.length, 1);
    }
  },
);
