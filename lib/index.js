import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { routeReview } from "./review-route.js";
import {
  createReviewChoiceListener,
  keepOutermost,
  withReviewDeadline,
} from "./review-choice.js";

/**
 * Owns the reviewer route and rewrites Auto review requests before they reach
 * the adapter. An empty provider or model keeps the shipped behaviour: the
 * reviewer follows the main model selected for the session.
 *
 * It also wraps the Auto review gate so a reviewer denial or a reviewer that
 * does not answer becomes a question to the user instead of a hard denial
 * (`onBlock: "ask"`, the default). `onBlock: "deny"` keeps the shipped
 * behaviour.
 */
class AutoCheckReviewer extends Service {
  static Config = z.object({
    provider: z.string().default("").volatile(),
    model: z.string().default("").volatile(),
    protocol: z.string().default("auto").volatile(),
    maxInputChars: z.number().default(64000).volatile(),
    onBlock: z.string().default("ask").volatile(),
    reviewTimeoutMs: z.number().default(60000).volatile(),
  });

  constructor(ctx, config) {
    super(ctx, "autoCheckReviewer");
    this.config = config;

    ctx.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });

    ctx.inject(["llm"], (child) => {
      child.effect(() =>
        child.on(
          "llm/stream",
          (options, next) => {
            const deadline = new AbortController();
            const stream = routeReview(
              options,
              {
                provider: this.config.provider.get(),
                model: this.config.model.get(),
                protocol: this.config.protocol.get(),
                maxInputChars: this.config.maxInputChars.get(),
                signal: deadline.signal,
              },
              (request) => child.llm.stream(request),
            );
            if (stream === undefined) return next();
            return withReviewDeadline(
              stream,
              Number(this.config.reviewTimeoutMs.get()),
              () => deadline.abort(new Error("auto-check: reviewer timed out")),
            );
          },
          { global: true, prepend: true },
        ),
      );
    });

    // Services are looked up per call, so a missing `userQuestions` service
    // simply keeps the original denial (the same as `onBlock: "deny"`).
    // `keepOutermost` documents why this listener must wrap the gate and how
    // it stays at index 0 regardless of plugin load order.
    const listener = createReviewChoiceListener({
      onBlock: () => this.config.onBlock.get(),
      userQuestions: () => ctx.get("userQuestions"),
      approval: () => ctx.get("approval"),
    });
    ctx.effect(() => keepOutermost(ctx, "tools/pre-execute", listener));
  }
}

export { AutoCheckReviewer as default };
