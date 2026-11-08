window.__ModuleLoader__.load({
  id: "dsh-auto-check",
  factory: (require) => {
    const { jsx, jsxs } = require("react/jsx-runtime");
    const {
      SettingsForm,
      SettingsFormModel,
      settingsTextField,
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "settings.autoCheck";
    const ENTRY_ID = "dsh-auto-check";
    const SEP = "\u0000";

    const css =
      ".dshAutoCheckField{display:grid;gap:6px;padding:12px 0}" +
      ".dshAutoCheckLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}" +
      ".dshAutoCheckSelect{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;min-height:32px;padding:4px 8px;width:100%;max-width:520px}" +
      ".dshAutoCheckSelect:disabled{opacity:.6}" +
      ".dshAutoCheckHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}" +
      ".dshAutoCheckNotice{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}" +
      ".dshAutoCheckError{display:flex;align-items:center;gap:12px;margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}" +
      ".dshAutoCheckError button{background:0 0;border:0;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;padding:0}";
    const tagId = "dsh-auto-check/settings.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="' + tagId + '"]') === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-auto-check";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const zh = {
      title: "自动审查模型",
      description: "为自动审查单独选择审查模型，不再跟随主模型。",
      reviewerModel: "审查模型",
      followMain: "跟随主模型（默认）",
      hint: "自动审查的请求会改走这里选择的模型；留空则保持原有行为。只影响自动审查，不影响主对话。",
      protocol: "审查协议",
      protocolAuto: "自动识别（模型名含 Qwen3Guard）",
      protocolJson: "标准 JSON（通用模型）",
      protocolQwen3Guard: "Qwen3Guard 安全分级",
      protocolHint: "Qwen3Guard 模式会去掉 auto review 的 JSON 策略，把待审内容作为用户消息发送，并把 Safety 标签映射为风险等级：Safe 放行，Controversial / Unsafe 拒绝。",
      protocolWarning: "Controversial 按中风险拒绝；默认审批策略下可能转人工确认，审批策略为 never 时直接拒绝。",
      loading: "正在加载可用模型…",
      loadFailed: "无法加载模型列表。",
      retry: "重试",
      partial: "部分提供商暂不可用，列表可能不完整。",
      unlisted: "当前配置（不在列表）",
      empty: "没有可用的模型。",
      unavailable: "此设置当前不可用。",
      readOnly: "此设置当前为只读。",
      saveFailed: "保存失败，请重试。",
      save: "保存",
      saving: "保存中…",
    };
    const en = {
      title: "Auto review model",
      description: "Choose a dedicated reviewer model for Auto review instead of following the main model.",
      reviewerModel: "Reviewer model",
      followMain: "Follow the main model (default)",
      hint: "Auto review requests are routed to this model. Leave it empty to keep the original behaviour. Only Auto review is affected.",
      protocol: "Review protocol",
      protocolAuto: "Auto-detect (Qwen3Guard in model name)",
      protocolJson: "Standard JSON (general models)",
      protocolQwen3Guard: "Qwen3Guard safety grading",
      protocolHint: "Qwen3Guard mode removes auto review's JSON policy, sends the pending content as the user message, and maps the Safety label to a risk level: Safe allows; Controversial / Unsafe deny.",
      protocolWarning: "Controversial is denied as medium risk; the default approval policy may turn it into a user confirmation, while a `never` override denies it outright.",
      loading: "Loading available models…",
      loadFailed: "Could not load the model list.",
      retry: "Retry",
      partial: "Some providers are unavailable, so the list may be incomplete.",
      unlisted: "Current setting (not listed)",
      empty: "No models are available.",
      unavailable: "This setting is currently unavailable.",
      readOnly: "This setting is read-only.",
      saveFailed: "Could not save. Try again.",
      save: "Save",
      saving: "Saving…",
    };

    const labels = (t) => ({
      unavailable: t("unavailable"),
      readOnly: t("readOnly"),
      saveFailed: t("saveFailed"),
      save: t("save"),
      saving: t("saving"),
    });

    class AutoCheckCardController {
      constructor(ctx, scope) {
        this.ctx = ctx;
        this.form = new SettingsFormModel(scope, [
          settingsTextField("provider"),
          settingsTextField("model"),
          settingsTextField("protocol"),
        ]);
        this.actions = this.form.actions();
        this.store = this.form.bind(() => this.projection());
        this.groups = [];
        this.catalogStatus = "loading";
        this.catalogPartial = false;
        this.generation = 0;
        void this.refreshCatalog();
      }

      projection() {
        return {
          ...this.form.shell(),
          provider: this.form.field("provider"),
          model: this.form.field("model"),
          protocol: this.form.field("protocol"),
          groups: this.groups,
          catalogStatus: this.catalogStatus,
          catalogPartial: this.catalogPartial,
        };
      }

      publish() {
        this.form.publish();
      }

      async refreshCatalog() {
        const generation = ++this.generation;
        this.catalogStatus = "loading";
        this.catalogPartial = false;
        this.publish();
        try {
          const response = await this.ctx.remote.session.modelCatalog();
          if (generation !== this.generation) return;
          if (response !== undefined && response.ok) {
            this.groups = response.value.groups;
            this.catalogPartial = response.value.failures.length > 0;
            this.catalogStatus = "ready";
          } else {
            this.catalogStatus = "error";
          }
        } catch {
          if (generation !== this.generation) return;
          this.catalogStatus = "error";
        }
        this.publish();
      }

      selectRoute(route) {
        if (route === null) {
          this.actions.edit("provider", "");
          this.actions.edit("model", "");
          this.actions.edit("protocol", "auto");
          return;
        }
        this.actions.edit("provider", route.provider);
        this.actions.edit("model", route.model);
        const protocol = this.form.field("protocol").text.trim().toLowerCase();
        if (protocol === "qwen3guard" && !/qwen3guard/i.test(route.model)) {
          this.actions.edit("protocol", "auto");
        }
      }

      inject() {
        return {
          hooks: { autoCheckCard: this.store },
          ...this.actions,
        };
      }

      dispose() {
        this.form.dispose();
      }
    }

    function AutoCheckCard(props) {
      const { t } = props;
      const state = props.useAutoCheckCard((snapshot) => snapshot);
      if (props.view === "summary") return t("description");

      const provider = state.provider.text.trim();
      const model = state.model.text.trim();
      const protocol = state.protocol.text.trim() || "auto";
      const current = provider !== "" && model !== "" ? provider + SEP + model : "";
      const routes = new Set();
      for (const group of state.groups) {
        for (const item of group.models) routes.add(group.id + SEP + item.id);
      }
      const unlisted = current !== "" && !routes.has(current);

      const options = [
        jsx("option", { value: "", children: t("followMain") }, "__follow_main__"),
      ];
      for (const group of state.groups) {
        options.push(
          jsxs(
            "optgroup",
            {
              label: group.name,
              children: group.models.map((item) =>
                jsx(
                  "option",
                  {
                    value: group.id + SEP + item.id,
                    children: item.name + " · " + group.name,
                  },
                  group.id + SEP + item.id,
                ),
              ),
            },
            group.id,
          ),
        );
      }
      if (unlisted) {
        options.push(
          jsx(
            "option",
            {
              value: current,
              children:
                provider + " / " + model + " (" + t("unlisted") + ")",
            },
            "__unlisted__",
          ),
        );
      }

      const onSelect = (event) => {
        const value = event.target.value;
        if (value === "") {
          props.selectRoute(null);
          return;
        }
        const index = value.indexOf(SEP);
        props.selectRoute({
          provider: value.slice(0, index),
          model: value.slice(index + SEP.length),
        });
      };

      return jsx(SettingsForm, {
        labels: labels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: jsxs("div", {
          children: [
            jsxs("div", {
              className: "dshAutoCheckField",
              children: [
                jsx("label", {
                  className: "dshAutoCheckLabel",
                  htmlFor: "dsh-auto-check-model",
                  children: t("reviewerModel"),
                }),
                jsx("select", {
                  className: "dshAutoCheckSelect",
                  id: "dsh-auto-check-model",
                  value: current,
                  disabled: !state.writable || state.saving,
                  onChange: onSelect,
                  children: options,
                }),
              ],
            }),
            jsxs("div", {
              className: "dshAutoCheckField",
              children: [
                jsx("label", {
                  className: "dshAutoCheckLabel",
                  htmlFor: "dsh-auto-check-protocol",
                  children: t("protocol"),
                }),
                jsx("select", {
                  className: "dshAutoCheckSelect",
                  id: "dsh-auto-check-protocol",
                  value: protocol,
                  disabled: !state.writable || state.saving,
                  onChange: (event) => props.edit("protocol", event.target.value),
                  children: [
                    jsx("option", { value: "auto", children: t("protocolAuto") }, "auto"),
                    jsx("option", { value: "json", children: t("protocolJson") }, "json"),
                    jsx("option", { value: "qwen3guard", children: t("protocolQwen3Guard") }, "qwen3guard"),
                  ],
                }),
              ],
            }),
            jsx("p", {
              className: "dshAutoCheckHint",
              children: t("hint"),
            }),
            jsx("p", {
              className: "dshAutoCheckHint",
              children: t("protocolHint"),
            }),
            protocol === "qwen3guard"
              ? jsx("p", {
                  className: "dshAutoCheckNotice",
                  children: t("protocolWarning"),
                })
              : null,
            state.catalogStatus === "loading"
              ? jsx("p", {
                  className: "dshAutoCheckNotice",
                  role: "status",
                  children: t("loading"),
                })
              : null,
            state.catalogStatus === "error"
              ? jsxs("p", {
                  className: "dshAutoCheckError",
                  role: "alert",
                  children: [
                    jsx("span", { children: t("loadFailed") }),
                    jsx("button", {
                      type: "button",
                      disabled: state.saving,
                      onClick: () => props.retryCatalog(),
                      children: t("retry"),
                    }),
                  ],
                })
              : null,
            state.catalogPartial
              ? jsx("p", {
                  className: "dshAutoCheckNotice",
                  children: t("partial"),
                })
              : null,
            state.catalogStatus === "ready" && state.groups.length === 0
              ? jsx("p", {
                  className: "dshAutoCheckNotice",
                  children: t("empty"),
                })
              : null,
          ],
        }),
      });
    }

    const inject = ["slots", "locale", "remote", "remote.session", "configForms"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-auto-check: dictionaries");

      const card = new AutoCheckCardController(
        ctx,
        ctx.configForms.get(ENTRY_ID),
      );
      ctx.effect(() => () => card.dispose(), "dsh-auto-check: form subscription");

      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject("plugins.item", () =>
              ctx.slots.register(
                {
                  name: "plugins.item",
                  id: ENTRY_ID,
                  order: 34,
                  label: () => t("title"),
                  locale: NS,
                  inject: () => ({
                    ...card.inject(),
                    retryCatalog: () => card.refreshCatalog(),
                    selectRoute: (route) => card.selectRoute(route),
                  }),
                },
                AutoCheckCard,
              ),
            ),
          ),
        "dsh-auto-check: page",
      );
    }

    return { inject, apply };
  },
});
