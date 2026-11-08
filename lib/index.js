import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { routeReview } from "./review-route.js";

/**
 * Owns the reviewer route and rewrites Auto review requests before they reach
 * the adapter. An empty provider or model keeps the shipped behaviour: the
 * reviewer follows the main model selected for the session.
 */
class AutoCheckReviewer extends Service {
  static Config = z.object({
    provider: z.string().default("").volatile(),
    model: z.string().default("").volatile(),
    protocol: z.string().default("auto").volatile(),
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
          (options, next) =>
            routeReview(
              options,
              {
                provider: this.config.provider.get(),
                model: this.config.model.get(),
                protocol: this.config.protocol.get(),
              },
              (request) => child.llm.stream(request),
            ) ?? next(),
          { global: true, prepend: true },
        ),
      );
    });
  }
}

export { AutoCheckReviewer as default };
