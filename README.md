# dsh-auto-check

为 DeepSeek Harness 的「自动审查」（Auto review）单独指定审查模型。

自动审查默认跟随当前会话的主模型。主模型如果是价格较高的模型，每次工具调用前的审查都会消耗同样的高价 Token。本插件在 `llm/stream` 层拦截自动审查请求，把它改写到单独配置的 provider / model，其余请求原样放行。

## 工作方式

- 自动审查请求的 `system` 提示以 `REVIEW_POLICY\n` 开头，这是插件识别它的唯一稳定标记。
- 命中后，插件用配置的 provider / model 重新发起一次 LLM 请求；只配置了一半（只填 provider 或只填 model）时视为未配置，继续跟随主模型。
- 标准 JSON 协议下，插件会在自带策略之后追加一段中文要求：每次拒绝都必须带 `reason`，并说清这次操作会做什么、为什么拒绝（见「拒绝原因用中文说明」）。
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
6. 保持勾选「拒绝原因用中文说明」（默认），让拒绝原因用中文说清这次操作会做什么、为什么拒绝；关闭后使用自带的英文策略原文。
7. 审查模型走的网关拒绝 `store` 字段时，勾选「兼容模式」（`compatMode`），见「云端 / 兼容网关」一节。

模型列表来自当前会话可路由的模型目录。打开页面、窗口重新聚焦，以及模型/凭据设置变更时会自动刷新；也可以点击「刷新列表」手动重新拉取。只影响自动审查，不影响主对话或子代理。

## 拒绝原因用中文说明（`chineseReason`）

标准 JSON 协议下，插件会在自带 `REVIEW_POLICY` 原文之后追加一段要求（`REASON_POLICY_ZH`，首行标记 `REVIEW_ADDENDUM_ZH`）：

- 每次拒绝都必须带 `reason`；
- `reason` 只能用简体中文书写，JSON 键名不翻译；不允许整段英文或繁体中文；
- `reason` 必须按顺序说清两件事：**① 这次操作会做什么**（命令、目标、路径、主机、数据范围、是否可逆），**② 为什么拒绝**（属于哪一档风险、违反了哪条规则；如果只是缺少授权，说明需要哪一项明确授权）；
- `reason` 仍是单行 JSON 字符串：不换行、不用 Markdown、不整段引用被审内容；
- 放行仍然只有两个成员且不带 `reason`，允许的 6 种 JSON 形态不变。

几点行为约定：

- 追加是幂等的：同一个请求只会追加一次，递归改写不会叠加。
- 关闭开关后使用自带策略原文；「跟随主模型」时同样会追加（语言与路由无关），只配置了一半模型时也照常追加。
- `protocol: qwen3guard` 不使用 JSON 策略，因此不追加这段要求。

## 审查拒绝时：把选择权交还给你

自动审查在以下三种情况下会阻止工具调用：

| 情况 | 原有行为 | 现在（`onBlock: ask`，默认） |
| --- | --- | --- |
| 审查模型拒绝，审批策略为 `never` 覆盖 | 直接拒绝 | 弹出问题让你选择 |
| 审查模型拒绝，审批策略为 `ask` | 弹出宿主的审批确认 | **弹出本插件的问题卡片**（工具 / 命令 / 参数 / 原因） |
| 审查模型拒绝，配置的审批策略为 `never` | 审批服务自动拒绝 | 弹出问题让你选择 |
| 审查模型出错 / 无响应 / 超时 | 直接拒绝（fail-closed） | 弹出问题让你选择 |

问题卡片按固定顺序显示，长短各有安排（三种拒绝情况结构相同）：

| 区块 | 内容 | 超长时 |
| --- | --- | --- |
| 工具 | 工具名 | — |
| 命令 | AI 将要执行的命令 | **完整保留，绝不截断**：放行前要能看清它到底做什么 |
| 参数 | 其余参数（JSON） | 超过 4000 字符截断，并注明还有多少字符未显示 |
| 原因 | 审查模型给出的拒绝原因；Qwen3Guard 的 `Safety:` / `Categories:` 作为前两行放在同一段引用里，后面接模型原话 | 超过 1200 字符保留首尾并注明折叠字数；中英重复的宿主导语只保留中文 |

Qwen3Guard 的回答退化（复述被审内容、夹带 chat template 标记、图片或 HTML 片段）时，插件只认开头 300 字符内的 `Safety:` 标签和 `Categories:` 分类，其余一律丢弃——被审内容本身可能就写着 `Safety:`，出现在后面的标签不算结论。拿不到标签按高风险拒绝，原因用固定中文句子（重试后仍失败会另有说明），绝不会把模型原始输出贴进卡片。

选项为：

- **维持拒绝**（推荐，默认预选）：工具不执行，代理收到原来的拒绝结果。
- **仍要执行（放行一次）**：只执行这一次调用，不会放行其他调用。

安全底线：只有明确点选「放行一次」才会执行。跳过、取消、自定义输入、会话中止、没有可用的提问通道（例如无界面运行或子代理）或提问出错时，**一律维持原拒绝**，绝不静默放行。

只问一次：`ask` 形态的闸门本来只是「请宿主审批卡片去问用户」，不是结论。本插件既然已经问过，就不再把它原样交回去——你选「维持拒绝」或直接跳过时，返回的是终态拒绝（`kind: "deny"` + `info.code: AUTO_REVIEW_DENIED`，与自动审查自己的拒绝形态一致），宿主不会再弹第二次审批。只有根本没问成（提问服务不可用、提问报错、会话中止）时才原样交回闸门，让宿主按原逻辑兜底。

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
- 模型没有返回 `Safety:` 标签时先缩小输入重试一次；仍无标签则按高风险拒绝（fail-closed），原因用固定中文句子，不复述模型原文。

> Qwen3Guard 只判断内容安全，不判断工具调用的业务正确性；`Safe` 只代表内容没有命中安全分类，不代表这次工具调用一定符合你的意图。

> Qwen3Guard 只支持 Gen 系列的安全分级输出，Stream 系列是逐 token 审核，不适用本适配。`Controversial` 在本插件中映射为中风险拒绝：默认（`onBlock: ask`）会弹出问题，由你选择放行一次或维持拒绝，审批策略为 `never` 时也是如此；设为 `onBlock: deny` 则恢复原有行为（`never` 下直接拒绝）。若模型别名不含 `Qwen3Guard`，请在「审查协议」中显式选择 Qwen3Guard。

> 审查模型不可用（例如凭据失效、模型下线、超过「审查超时」）时，默认会把失败原因展示给你并由你选择放行一次或维持拒绝；`onBlock: deny` 时按原有失败策略直接拒绝。长期不可用时请换回「跟随主模型」或选择一个可用模型。

### 长会话与 32k 上下文

自动审查会把当前会话的过滤历史和待审工具调用一起发给审查模型。长会话的审查输入可能达到数万 Token，超过 Qwen3Guard-Gen 本地 32k 上下文，导致自动审查失败（默认每次都会弹出选择，`onBlock: deny` 时直接拒绝）。

「最大审查字符数」用于 Qwen3Guard 协议，默认 `24000` 字符。超过预算时按消息裁剪：**保留 `ENVIRONMENT` 头和最后一条待审调用**（待审调用上限为预算的一半），历史从最新往旧塞，放不下的整条丢弃，并在原位置留下 `[... auto-review input truncated: N earlier history message(s) dropped ...]` 标记；只有单条超长时才退回「保留首尾、截断中间」。

这个值不是越小越稳、越大越省事：实测该模型在 24k 字符以内稳定输出标签，超过 30k 后开始出现非确定性退化（回显 prompt、复读数字、`</endoftext>` + `</BEG>`、空输出），长输入单次耗时可达 10–21 秒。设为 `0` 会关闭裁剪，不建议对本地 32k 模型使用。

退化答案常常不带 `Safety:` 标签，所以第一次回答里没有标签时，插件会用 8000 字符预算自动重试一次：能装下就只发待审调用，装不下就压缩同一段内容——重试总是改变一个变量，不会把同样的提示原样再发一遍。重试只发生在已交付的回答上；流本身报错、超时或中止时不重试，直接走原来的失败路径。

### Qwen3Guard 能挡住什么、挡不住什么

它做的是**内容安全判定**（Jailbreak、Violent、Non-violent Illegal Acts 等），不是**授权判定**。实测同一个 4B 模型：

- 能识别：删除系统目录、`curl ... | powershell`、把凭据 POST 到外部（判为 Controversial）、批量建管理员账号（Unsafe）；
- 会漏判：`format C: /q /y`、`shutdown /s /t 0`、`git push --force`、`git reset --hard`、`npm publish`、`DROP TABLE`、读取 `.credentials.yaml`——这些都判成 `Safe`。

所以它是**廉价的预筛**，不能当唯一的授权闸门。需要真正的破坏性操作审查时，请把审查模型换成通用模型并使用标准 JSON 协议（它能读懂命令语义，也能给出中文 reason），Qwen3Guard 适合作为第二道或低配环境下的兜底。

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

也可以直接在本插件设置里勾选 **兼容模式**（`compatMode`，默认关闭），由插件替你维护这条配置：

- 开启时：在当前审查模型所属 provider 的 pi-ai 配置（`llm-pi-ai` 条目的 `providers.<provider>`）里写入 `compat.supportsStore: false`；已经是 `false` 时不重复写入。之后切换审查模型，也会给新 provider 写入。
- 关闭时：从当前审查 provider 的配置里移除 `compat.supportsStore`（`compat` 中没有其他项时整段移除）。插件启动时开关为关闭则不做任何修改，不会删掉你手写的配置；来自更低配置层的值也不会被移除。
- 只在选择了单独的审查模型（「跟随主模型」以外）且该 provider 已在 pi-ai 的 `providers` 中声明时生效。
- pi-ai 只从 provider / model 配置读取 `compat`，单次请求里携带 `compat` 不会生效，所以兼容模式必须修改 provider 配置；这会同时影响主对话里使用该 provider 的请求。

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
node --check lib/review-route.js
node --check lib/review-choice.js
node --check lib/compat-mode.js
node --check client.js
```

沙箱环境里 `node --test` 会因为没有管道权限而 `spawn EPERM`，此时逐个文件跑：`node test/review-route.test.mjs`、`node test/review-choice.test.mjs`、`node test/compat-mode.test.mjs`。

测试覆盖：普通请求放行、审查请求改写、递归回放、空配置回退、半配置跟随主模型、同路由仍追加中文策略、Qwen3Guard 协议探测、请求改写与字符预算、按消息裁剪（保留环境与待审调用、丢弃最旧历史）、无标签时的固定拒绝文案、自动缩小输入重试、标签映射与流转换；审查闸门三种拒绝形态识别、提问与答案解析、提问失败一律维持拒绝、审查超时合成 `REVIEWER_TIMEOUT` 结束块；兼容模式按开关增删 `compat.supportsStore`、保留其他 `compat` 项且不动更低配置层的值，以及在真实 cordis 中两种加载顺序下都位于闸门外层（找不到宿主 checkout 时该项跳过）。
