import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { routeReview } from "./review-route.js";
import { syncCompat } from "./compat-mode.js";
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
 *
 * `chineseReason` (the default) appends a Simplified-Chinese reasoning
 * requirement to the standard JSON review policy, so every denial explains what
 * the call would do and why it was refused (see `review-route.js`).
 * `protocol: "qwen3guard"` bypasses the JSON policy entirely.
 *
 * `compatMode` keeps `compat.supportsStore: false` on the reviewer provider's
 * pi-ai profile (see `compat-mode.js`). Turning it off removes the flag from
 * the currently selected reviewer provider; a disabled switch at startup
 * leaves existing provider configuration untouched.
 */
class AutoCheckReviewer extends Service {
  static Config = z.object({
    provider: z.string().default("").volatile(),
    model: z.string().default("").volatile(),
    protocol: z.string().default("auto").volatile(),
    maxInputChars: z.number().default(24000).volatile(),
    chineseReason: z.boolean().default(true).volatile(),
    onBlock: z.string().default("ask").volatile(),
    reviewTimeoutMs: z.number().default(60000).volatile(),
    compatMode: z.boolean().default(false).volatile(),
  });

  constructor(ctx, config) {
    super(ctx, "autoCheckReviewer");
    this.config = config;

    // Compatibility mode writes through the settings service, which may load
    // after this plugin or be replaced. Syncs run one at a time.
    let settings;
    let queue = Promise.resolve();
    let refreshQueued = false;
    let lastEnabled = this.config.compatMode.get() === true;
    const reviewerProvider = () => {
      const provider = String(this.config.provider.get() ?? "").trim();
      const model = String(this.config.model.get() ?? "").trim();
      return provider !== "" && model !== "" ? provider : "";
    };
    const enqueueCompat = (enabled) => {
      const provider = reviewerProvider();
      if (provider === "") return;
      queue = queue
        .then(async () => {
          if (settings === undefined) return;
          const { ns, ops } = await syncCompat(settings, provider, enabled);
          if (ops.length > 0) {
            ctx.logger.info(
              "auto-check: compat mode %s compat.supportsStore for %s in %s",
              enabled ? "set" : "removed",
              provider,
              ns,
            );
          }
        })
        .catch((error) => {
          ctx.logger.warn("auto-check: could not update provider compat for %s", provider);
          ctx.logger.warn(error);
        });
    };
    // Re-check when settings documents change (for example the pi-ai entry
    // loading after this plugin). Our own write also lands here, finds
    // nothing to do, and stops.
    const refreshCompat = () => {
      if (this.config.compatMode.get() !== true || refreshQueued) return;
      refreshQueued = true;
      queue = queue.then(() => {
        refreshQueued = false;
      });
      enqueueCompat(true);
    };

    ctx.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
      child.effect(() => {
        settings = child.settings;
        refreshCompat();
        return () => {
          if (settings === child.settings) settings = undefined;
        };
      });
      child.effect(() => child.on("settings/document-updated", refreshCompat));
    });

    ctx.on("loader/volatile-update", () => {
      const enabled = this.config.compatMode.get() === true;
      if (enabled) enqueueCompat(true);
      else if (lastEnabled) enqueueCompat(false);
      lastEnabled = enabled;
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
                reasonPolicy: this.config.chineseReason.get() !== false,
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
    });
    ctx.effect(() => keepOutermost(ctx, "tools/pre-execute", listener));
  }
}

export { AutoCheckReviewer as default };
