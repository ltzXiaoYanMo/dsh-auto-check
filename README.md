# dsh-auto-check

为 DeepSeek Harness 的「自动审查」（Auto review）单独指定审查模型。

自动审查默认跟随当前会话的主模型。主模型如果是价格较高的模型，每次工具调用前的审查都会消耗同样的高价 Token。本插件在 `llm/stream` 层拦截自动审查请求，把它改写到单独配置的 provider / model，其余请求原样放行。

## 工作方式

- 自动审查请求的 `system` 提示以 `REVIEW_POLICY\n` 开头，这是插件识别它的唯一稳定标记。
- 命中后，插件用配置的 provider / model 重新发起一次 LLM 请求；未配置或只配置了一半时，保持原有行为。
- 改写后的请求会被标记，避免再次进入本插件造成递归。
- 不替换、不修改自带的 `auto-review` 插件；自动审查的策略、审批和拒绝逻辑全部保持原样。

## 配置

1. 打开 **设置 → 插件**（Plugins）。
2. 在官方插件列表中找到 **自动审查模型**。
3. 选择一个审查模型并保存；选择「跟随主模型」可恢复默认行为。
4. 按需选择「审查协议」：
   - **自动识别**（默认）：目标模型名包含 `Qwen3Guard` 时使用 Qwen3Guard 适配，否则使用标准 JSON 协议。
   - **标准 JSON**：要求审查模型严格输出 `{risk, decision, reason?}`，适用于通用模型。
   - **Qwen3Guard 安全分级**：适用于 Qwen3Guard-Gen 系列（0.6B / 4B / 8B）。

模型列表来自当前会话可路由的模型目录。只影响自动审查，不影响主对话或子代理。

## Qwen3Guard 适配

Qwen3Guard-Gen 原生输出不是 JSON，而是两行文本：

```text
Safety: Safe | Controversial | Unsafe
Categories: <分类列表 | None>
```

本插件在 Qwen3Guard 协议下：

- 去掉 auto review 的 JSON 策略 `system`，只把待审内容作为一条 user 消息发送；
- 把 `Safe` 映射为低风险放行；
- 把 `Controversial` 映射为中风险拒绝，`Unsafe` 映射为高风险拒绝，拒绝原因保留分类；
- 把原生文本流转换为 auto review 期望的「一个 text block + stop」流；
- 模型没有返回 `Safety:` 标签时按高风险拒绝（fail-closed）。

> Qwen3Guard 只判断内容安全，不判断工具调用的业务正确性；`Safe` 只代表内容没有命中安全分类，不代表这次工具调用一定符合你的意图。

> Qwen3Guard 只支持 Gen 系列的安全分级输出，Stream 系列是逐 token 审核，不适用本适配。`Controversial` 在本插件中映射为中风险拒绝：在 auto review 的默认审批策略下，它可能被转成一次用户确认，而不是直接丢弃；如果审批策略是 `never`，则会直接拒绝。若模型别名不含 `Qwen3Guard`，请在「审查协议」中显式选择 Qwen3Guard。

> 审查模型不可用（例如凭据失效、模型下线）时，自动审查会按原有失败策略拒绝工具调用。换回「跟随主模型」或选择一个可用模型即可恢复。

## 安装

```powershell
# 在 DSH 中通过插件管理器安装本目录：
# plugin_manager install_bundle target=<本目录绝对路径>
```

安装后包会以 `link:` 方式加入 profile。Host 侧代码的模块和 Config schema 会被 Node 缓存，修改 `lib/` 后需要重启 DSH Desktop（Electron）才能重新加载；只刷新页面不会更新 Host 插件。客户端 `client.js` 改动在刷新页面后生效。

## 开发验证

```powershell
node --test test/review-route.test.mjs
node --check lib/index.js
node --check client.js
```

测试覆盖：普通请求放行、审查请求改写、递归回放、空配置回退、同路由不重复改写、Qwen3Guard 协议探测、请求改写、标签映射与流转换。

## 发布到 npm

仓库包含 `.github/workflows/publish.yml`：推送 `v*` tag 时测试并发布到 npm，使用 Trusted Publishing（OIDC），不保存长期 npm token。

首次发布需要手动认领包名：

```powershell
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```

然后在 npmjs.com 的包设置 → Trusted Publishing 中添加 GitHub Actions：

- Owner: `ltzXiaoYanMo`
- Repository: `dsh-auto-check`
- Workflow: `publish.yml`

之后的发布流程：

```powershell
git tag v0.1.1
git push origin v0.1.1
```

`dsh-plugins` 是仓库里程碑 tag，不会触发 npm 发布。

