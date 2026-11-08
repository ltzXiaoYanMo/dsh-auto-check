window.__ModuleLoader__.load({
  id: "dsh-auto-check",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const {
      SettingsForm,
      SettingsFormModel,
      settingsNumberField,
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
      ".dshAutoCheckInput{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;min-height:32px;padding:4px 8px;width:100%;max-width:260px}" +
      ".dshAutoCheckInput:disabled{opacity:.6}" +
      ".dshAutoCheckCheck{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;cursor:pointer}" +
      ".dshAutoCheckCheck input:disabled{opacity:.6}" +
      ".dshAutoCheckHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}" +
      ".dshAutoCheckRefresh{display:flex;align-items:center;gap:8px;margin:0}" +
      ".dshAutoCheckRefresh button{background:0 0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:2px 10px}" +
      ".dshAutoCheckRefresh button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".dshAutoCheckRefresh button:disabled{opacity:.5;cursor:default}" +
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
      protocolWarning: "Controversial 按中风险拒绝。按下方「审查拒绝时」的设置，默认会弹出问题让你选择放行一次或维持拒绝（审批策略为 never 时同样如此）。",
      onBlock: "审查拒绝时",
      onBlockAsk: "询问我：放行一次或维持拒绝（默认）",
      onBlockDeny: "直接拒绝（原有行为）",
      onBlockHint: "审查模型拒绝、出错或超时时，默认把原因展示给你并由你选择；跳过、取消或无法弹出问题时一律维持拒绝。选「直接拒绝」恢复原有的失败即拒绝行为。",
      reviewTimeoutMs: "审查超时",
      reviewTimeoutMsHint: "单独配置的审查模型超过此时长仍未给出结果时，视为无响应并交给你选择。0 表示不限时。跟随主模型时不生效。",
      reviewTimeoutMsUnit: "毫秒",
      maxInputChars: "最大审查字符数",
      maxInputCharsHint: "Qwen3Guard 模式下，超过此长度的审查内容会保留首尾、截断中间，避免 32k 本地模型上下文溢出。0 表示不截断。",
      maxInputCharsUnit: "字符",
      compatMode: "兼容模式",
      compatModeHint: "开启后，在审查模型所属 provider 的配置中添加 compat.supportsStore: false，用于拒绝 store 字段的 OpenAI 兼容网关；关闭后移除该项。只在选择了单独的审查模型时生效，并会修改该 provider 的模型设置。",
      loading: "正在加载可用模型…",
      refresh: "刷新列表",
      refreshing: "刷新中…",
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
      protocolWarning: "Controversial is denied as medium risk. With \"When review blocks\" below set to ask (the default), you are asked to allow it once or keep it denied, including under the `never` approval policy.",
      onBlock: "When review blocks",
      onBlockAsk: "Ask me: allow once or keep denied (default)",
      onBlockDeny: "Deny outright (original behaviour)",
      onBlockHint: "When the reviewer denies, errors or times out, the reason is shown and you decide. A skipped, cancelled or undeliverable question always keeps the denial. Choose \"Deny outright\" to restore the original fail-closed behaviour.",
      reviewTimeoutMs: "Review timeout",
      reviewTimeoutMsHint: "If a dedicated reviewer model gives no result within this time, it counts as unresponsive and you decide. 0 disables the timeout. Not applied when following the main model.",
      reviewTimeoutMsUnit: "milliseconds",
      maxInputChars: "Maximum review characters",
      maxInputCharsHint: "In Qwen3Guard mode, longer review input keeps its head and tail and drops the middle, so a 32k local model does not overflow. 0 disables truncation.",
      maxInputCharsUnit: "characters",
      compatMode: "Compatibility mode",
      compatModeHint: "When on, adds compat.supportsStore: false to the reviewer model's provider configuration, for OpenAI-compatible gateways that reject the store field; turning it off removes it. Applies only when a dedicated reviewer model is selected, and edits that provider's model settings.",
      loading: "Loading available models…",
      refresh: "Refresh list",
      refreshing: "Refreshing…",
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
          settingsNumberField("maxInputChars"),
          settingsTextField("onBlock"),
          settingsNumberField("reviewTimeoutMs"),
          {
            field: "compatMode",
            format: (value) => (value === true ? "true" : "false"),
            parse: (text) => ({ kind: "set", value: text === "true" }),
          },
        ]);
        this.actions = this.form.actions();
        this.store = this.form.bind(() => this.projection());
        this.groups = [];
        this.catalogStatus = "loading";
        this.catalogPartial = false;
        this.generation = 0;
      }

      projection() {
        return {
          ...this.form.shell(),
          provider: this.form.field("provider"),
          model: this.form.field("model"),
          protocol: this.form.field("protocol"),
          maxInputChars: this.form.field("maxInputChars"),
          onBlock: this.form.field("onBlock"),
          reviewTimeoutMs: this.form.field("reviewTimeoutMs"),
          compatMode: this.form.field("compatMode"),
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
      const refreshRef = React.useRef(props.refreshCatalog);
      refreshRef.current = props.refreshCatalog;

      React.useEffect(() => {
        refreshRef.current();
      }, []);

      React.useEffect(() => {
        const refresh = () => refreshRef.current();
        const onVisibility = () => {
          if (document.visibilityState === "visible") refresh();
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
          window.removeEventListener("focus", refresh);
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }, []);

      if (props.view === "summary") return t("description");

      const provider = state.provider.text.trim();
      const model = state.model.text.trim();
      const protocol = state.protocol.text.trim() || "auto";
      const onBlock =
        (state.onBlock?.text ?? "").trim().toLowerCase() === "deny" ? "deny" : "ask";
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
            jsxs("div", {
              className: "dshAutoCheckField",
              children: [
                jsx("label", {
                  className: "dshAutoCheckLabel",
                  htmlFor: "dsh-auto-check-max-input",
                  children: t("maxInputChars"),
                }),
                jsx("input", {
                  className: "dshAutoCheckInput",
                  id: "dsh-auto-check-max-input",
                  type: "number",
                  min: 0,
                  step: 1000,
                  value: state.maxInputChars?.text ?? "",
                  disabled: !state.writable || state.saving,
                  onChange: (event) =>
                    props.edit("maxInputChars", event.target.value),
                }),
                jsx("p", {
                  className: "dshAutoCheckHint",
                  children: t("maxInputCharsHint"),
                }),
              ],
            }),
            jsxs("div", {
              className: "dshAutoCheckField",
              children: [
                jsx("label", {
                  className: "dshAutoCheckLabel",
                  htmlFor: "dsh-auto-check-on-block",
                  children: t("onBlock"),
                }),
                jsx("select", {
                  className: "dshAutoCheckSelect",
                  id: "dsh-auto-check-on-block",
                  value: onBlock,
                  disabled: !state.writable || state.saving,
                  onChange: (event) => props.edit("onBlock", event.target.value),
                  children: [
                    jsx("option", { value: "ask", children: t("onBlockAsk") }, "ask"),
                    jsx("option", { value: "deny", children: t("onBlockDeny") }, "deny"),
                  ],
                }),
                jsx("p", {
                  className: "dshAutoCheckHint",
                  children: t("onBlockHint"),
                }),
              ],
            }),
            jsxs("div", {
              className: "dshAutoCheckField",
              children: [
                jsx("label", {
                  className: "dshAutoCheckLabel",
                  htmlFor: "dsh-auto-check-review-timeout",
                  children: t("reviewTimeoutMs") + " (" + t("reviewTimeoutMsUnit") + ")",
                }),
                jsx("input", {
                  className: "dshAutoCheckInput",
                  id: "dsh-auto-check-review-timeout",
                  type: "number",
                  min: 0,
                  step: 1000,
                  value: state.reviewTimeoutMs?.text ?? "",
                  disabled: !state.writable || state.saving,
                  onChange: (event) =>
                    props.edit("reviewTimeoutMs", event.target.value),
                }),
                jsx("p", {
                  className: "dshAutoCheckHint",
                  children: t("reviewTimeoutMsHint"),
                }),
              ],
            }),
            jsxs("div", {
              className: "dshAutoCheckField",
              children: [
                jsxs("label", {
                  className: "dshAutoCheckCheck",
                  htmlFor: "dsh-auto-check-compat-mode",
                  children: [
                    jsx("input", {
                      id: "dsh-auto-check-compat-mode",
                      type: "checkbox",
                      checked: (state.compatMode?.text ?? "") === "true",
                      disabled: !state.writable || state.saving,
                      onChange: (event) =>
                        props.edit("compatMode", event.target.checked ? "true" : "false"),
                    }),
                    jsx("span", { children: t("compatMode") }),
                  ],
                }),
                jsx("p", {
                  className: "dshAutoCheckHint",
                  children: t("compatModeHint"),
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
            jsxs("div", {
              className: "dshAutoCheckRefresh",
              children: [
                jsx("button", {
                  type: "button",
                  disabled: state.catalogStatus === "loading" || state.saving,
                  onClick: () => props.refreshCatalog(),
                  children:
                    state.catalogStatus === "loading"
                      ? t("refreshing")
                      : t("refresh"),
                }),
              ],
            }),
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

      ctx.effect(() => {
        const events = [
          "llm/adapters-updated",
          "settings/document-updated",
          "credentials/record-updated",
          "credentials/reference-updated",
        ];
        const disposers = events.map((event) =>
          ctx.remote.$on(event, () => {
            void card.refreshCatalog();
          }),
        );
        return () => {
          for (const dispose of disposers) {
            if (typeof dispose === "function") dispose();
          }
        };
      }, "dsh-auto-check: model catalog refresh");

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
                    refreshCatalog: () => card.refreshCatalog(),
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
