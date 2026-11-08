# dsh-auto-check

为 DeepSeek Harness 的「自动审查」（Auto review）单独指定审查模型。

自动审查默认跟随当前会话的主模型。主模型如果是价格较高的模型，每次工具调用前的审查都会消耗同样的高价 Token。本插件在 `llm/stream` 层拦截自动审查请求，把它改写到单独配置的 provider / model，其余请求原样放行。

## 工作方式

- 自动审查请求的 `system` 提示以 `REVIEW_POLICY\n` 开头，这是插件识别它的唯一稳定标记。
- 命中后，插件用配置的 provider / model 重新发起一次 LLM 请求；未配置或只配置了一半时，保持原有行为。
- 改写后的请求会被标记，避免再次进入本插件造成递归。
- 不替换、不修改自带的 `auto-review` 插件；审查策略本身保持原样。插件只在其外层包一层 `tools/pre-execute` 监听，把「审查拒绝 / 审查失败」交给用户选择（见下文「审查拒绝时」）。

## 配置

1. 打开 **设置 → 插件**（Plugins）。
2. 在官方插件列表中找到 **自动审查模型**。
3. 选择一个审查模型并保存；选择「跟随主模型」可恢复默认行为。
4. 按需选择「审查协议」：
   - **自动识别**（默认）：目标模型名包含 `Qwen3Guard` 时使用 Qwen3Guard 适配，否则使用标准 JSON 协议。
   - **标准 JSON**：要求审查模型严格输出 `{risk, decision, reason?}`，适用于通用模型。
   - **Qwen3Guard 安全分级**：适用于 Qwen3Guard-Gen 系列（0.6B / 4B / 8B）。
5. 按需设置「审查拒绝时」（`onBlock`）与「审查超时」（`reviewTimeoutMs`），见下一节。

模型列表来自当前会话可路由的模型目录。打开页面、窗口重新聚焦，以及模型/凭据设置变更时会自动刷新；也可以点击「刷新列表」手动重新拉取。只影响自动审查，不影响主对话或子代理。

## 审查拒绝时：把选择权交还给你

自动审查在以下三种情况下会阻止工具调用：

| 情况 | 原有行为 | 现在（`onBlock: ask`，默认） |
| --- | --- | --- |
| 审查模型拒绝，审批策略为 `never` 覆盖 | 直接拒绝 | 弹出问题让你选择 |
| 审查模型拒绝，审批策略为 `ask` | 弹出审批确认 | 不变（仍由宿主的审批卡片确认） |
| 审查模型拒绝，配置的审批策略为 `never` | 审批服务自动拒绝 | 弹出问题让你选择 |
| 审查模型出错 / 无响应 / 超时 | 直接拒绝（fail-closed） | 弹出问题让你选择 |

问题卡片会显示工具名和审查原因（例如 `Qwen3Guard: Controversial (categories: ...)`），选项为：

- **维持拒绝**（推荐，默认预选）：工具不执行，代理收到原来的拒绝结果。
- **仍要执行（放行一次）**：只执行这一次调用，不会放行其他调用。

安全底线：只有明确点选「放行一次」才会执行。跳过、取消、自定义输入、会话中止、没有可用的提问通道（例如无界面运行或子代理）或提问出错时，**一律维持原拒绝**，绝不静默放行。

- `onBlock`：`ask`（默认）或 `deny`。`deny` 恢复原有行为：不弹问题，按原策略拒绝。
- `reviewTimeoutMs`：单独配置的审查模型在此时长（毫秒）内没有给出结果时，插件中止该请求并以 `REVIEWER_TIMEOUT` 错误结束审查流，自动审查据此判定「审查失败」，再交给你选择。默认 `60000`，`0` 表示不限时。只对本插件改写过路由的审查请求生效；「跟随主模型」时不加超时，但主模型出错导致的审查失败同样会弹出选择。

实现说明：宿主的审查闸门以 `prepend` 方式注册在 `tools/pre-execute` 上。cordis 的 `prepend` 使用 `unshift`，`waterfall` 从数组第 0 个开始执行，所以最后注册的 `prepend` 监听在最外层。插件加载顺序不固定，因此本插件监听 `internal/listener`：每当有新的 `prepend` 监听注册到 `tools/pre-execute`，就在下一个微任务把自己重新注册回最外层，保证总能拿到闸门的结果。测试用真实 cordis 验证了两种加载顺序。

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

> Qwen3Guard 只支持 Gen 系列的安全分级输出，Stream 系列是逐 token 审核，不适用本适配。`Controversial` 在本插件中映射为中风险拒绝：默认（`onBlock: ask`）会弹出问题，由你选择放行一次或维持拒绝，审批策略为 `never` 时也是如此；设为 `onBlock: deny` 则恢复原有行为（`never` 下直接拒绝）。若模型别名不含 `Qwen3Guard`，请在「审查协议」中显式选择 Qwen3Guard。

> 审查模型不可用（例如凭据失效、模型下线、超过「审查超时」）时，默认会把失败原因展示给你并由你选择放行一次或维持拒绝；`onBlock: deny` 时按原有失败策略直接拒绝。长期不可用时请换回「跟随主模型」或选择一个可用模型。

### 长会话与 32k 上下文

自动审查会把当前会话的过滤历史和待审工具调用一起发给审查模型。长会话的审查输入可能达到数万 Token，超过 Qwen3Guard-Gen 本地 32k 上下文，导致自动审查失败（默认每次都会弹出选择，`onBlock: deny` 时直接拒绝）。

「最大审查字符数」用于 Qwen3Guard 协议：超过预算时保留开头（环境与项目指令）和结尾（最近历史与待审调用），截断中间并插入标记。默认 `64000` 字符（约 16k Token），适配 32k 上下文并留出输出余量；设为 `0` 可关闭截断。使用更大上下文的远程模型时可以调高或关闭。

### 云端 / 兼容网关：`store` 字段被拒绝

一些 OpenAI 兼容网关（例如 Superlinked 代理的 Qwen3Guard）会返回：

```text
400 'store' is not supported by this endpoint (param: store, code: unsupported_field)
```

这是 pi-ai 的兼容层在 `compat.supportsStore` 为真时自动附加了 `store: false`，而网关不接受该字段。给该 provider 的模型配置 `compat`：

```yaml
security-example:
  api: openai-completions
  baseURL: https://example.com/v1
  compat:
    supportsStore: false # 添加这条
  models:
    - id: Qwen3Guard-Gen-4B
      name: Qwen3Guard-Gen-4B
```

本插件也会在 Qwen3Guard 请求中主动丢弃 `store`，但适配器层附加的字段需要在 provider 配置里关闭。

## 安装

```powershell
# 在 DSH 中通过插件管理器安装本目录：
# plugin_manager install_bundle target=<本目录绝对路径>
```

安装后包会以 `link:` 方式加入 profile。Host 侧代码的模块和 Config schema 会被 Node 缓存，修改 `lib/` 后需要重启 DSH Desktop（Electron）才能重新加载；只刷新页面不会更新 Host 插件。客户端 `client.js` 改动在刷新页面后生效。

## 开发验证

```powershell
npm test
node --check lib/index.js
node --check lib/review-choice.js
node --check client.js
```

测试覆盖：普通请求放行、审查请求改写、递归回放、空配置回退、同路由不重复改写、Qwen3Guard 协议探测、请求改写、字符预算截断、标签映射与流转换；审查闸门三种拒绝形态识别、提问与答案解析、提问失败一律维持拒绝、审查超时合成 `REVIEWER_TIMEOUT` 结束块，以及在真实 cordis 中两种加载顺序下都位于闸门外层（找不到宿主 checkout 时该项跳过）。
