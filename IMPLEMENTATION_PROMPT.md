# dsh-auto-check 实现提示词：把 Auto Review 的拒绝权交还用户

> 本提示词自包含：接手者不需要重新调研宿主源码，所有关键事实已验证并附源码位置。
> 交付前逐条核对「验收标准」，每条都要贴命令输出证据；没有证据的完成不算完成。

---

## 一、任务目标（用户原始需求，两条都必须闭环）

1. 拒绝转选择：Qwen3Guard 审查模型直接拒绝请求时，不能硬拒绝工具调用——必须把拒绝原因呈现给用户，让用户自行选择「放行一次」或「维持拒绝」。
2. 无响应回退：若配置的审查模型没有响应（超时/出错），把选择权交还给用户，而不是直接拒绝（当前 fail-closed 行为）。

## 二、工作区与关键文件

- 插件仓库：C:\Users\YanMo\source\repos\dsh-auto-check（git 98f2189 干净基线，Node v24.21.0，npm test = node --test test/review-route.test.mjs）
- 宿主 checkout：C:\Program Files\DSH Desktop Beta\resources\app\node_modules\@deepseek-ai\
- 待改文件：lib\index.js（48行）、新建 lib\review-choice.js、client.js（478行）、README.md（132行）、测试（新建 test\review-choice.test.mjs，并跑通现有 test\review-route.test.mjs）
- 现有 lib\review-route.js（285行）负责 llm/stream 改写路由，本任务基本不动它，只在其外围加 deadline 包装

## 三、已验证的宿主事实（全部有源码行号，勿凭记忆重写）

### 3.1 auto-review gate 的三种拒绝形态
文件：dsh-experimental-auto-review\lib\index.js
- denied(exec, reason)（417-427）返回 {kind:'deny', reason:'Auto review rejected tool "X"; its body was not executed', info:{name:'AutoReviewDeniedError', code:'AUTO_REVIEW_DENIED', reason?}}。仅在 decision==='deny' 且 ctx.approval.overrideOf(agent.session)==='never' 时返回（479行），且不调用 next()。
- askUser(exec, reason)（432-445）返回 {kind:'ask', reason:'Auto review denied tool "X": <reason>', displayReason:{en,zh}}。gate 在下游 allow 且审查 deny 时返回（483行）。
- failed(exec, error)（447-453）返回 {kind:'deny', reason:'Auto review of tool "X" failed; its body was not executed: <message>'}，无 info 成员（477行）。审查模型抛错/无响应走这里。
- gate 注册：ctx.on('tools/pre-execute', ..., {prepend:true})（461-488行），在自身 lifecycle effect 内。
- 常量：AUTO_REVIEW_DENIED_ERROR_NAME='AutoReviewDeniedError'（16行）、AUTO_REVIEW_DENIED_CODE='AUTO_REVIEW_DENIED'（18行）。
- readDecision（376-396）：对 {type:'finish', reason:{kind:'error'|'aborted'}} 做 const {code,message}=chunk.reason.failure 并 throw new Error('auto-review: reviewer ended with '+kind+' '+code+': '+message)；kind!=='stop' 或无 finish 也抛错。

### 3.2 waterfall 顺序（决定我们能否拦截 gate）
文件：cordis\lib\index.js
- waterfall（317-325）：cbs.shift()——数组第 0 个最先执行（最外层）；外层不调 next() 则内层全部被否决。
- register（335-345）：prepend:true 即 unshift。后注册 prepend 的监听者在最外层。
- 因此我们的 tools/pre-execute 监听必须比 gate 后注册（同为 prepend，我们落在 index 0），流程：我们先跑 → const gate = await next() 拿到 gate 的返回值（含 denied/failed/ask）→ 转换或透传。
- 注册时机风险：gate 在它自己的 apply lifecycle 里注册；我们的 Service constructor 注册时机取决于服务挂载顺序。实现时必须验证顺序（单测模拟两个 prepend 注册者，或运行时日志确认 hook 数组顺序）；若 constructor 时机不可靠，改用与 gate 相同的 lifecycle effect 模式并确保插件加载顺序在后（cordis.patch.yml 的 insert 位置可调整，当前内容仅为 insert id/name: dsh-auto-check）。
- tools/pre-execute 消费点：dsh-tools\lib\types\index.js:885 const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve({kind:'allow'}))；gate.kind==='ask' 时走 serviceAsk（886-888）；decision.kind==='allow' 才执行工具体，deny 时 reason/info 变成 isError 结果（896-907）。

### 3.3 serviceAsk 与 approval policy（为什么 ask 也会被自动拒绝）
文件：dsh-tools\lib\types\index.js:1102-1140
- 无 approval 服务 → deny；exec.agent===undefined → deny；approval.request() 结果映射：'allowed-once'→allow，'rejected'→deny（the user rejected tool "X"），'cancelled'→deny+approvalCancelled:true，'unavailable'→deny。
- dsh-user-approval\lib\types\index.js：effectivePolicy(session)=overrideOf(session) ?? this.config.policy ?? 'ask'（146-148）；request() 在 policy 为 never 时自动拒绝（178行附近）。
- 本会话事实：approval policy 已从 ask 改为 never（用户操作）→ gate 的 askUser 路径会被 serviceAsk 自动拒绝，denied 路径直接硬拒。所以两种都要接管。

### 3.4 userQuestions 通道（我们要用的提问 API）
文件：dsh-user-questions\lib\types\index.js:294-338，服务名 userQuestions（93行 super(ctx,'userQuestions')）
- ask(request) 校验：request.signal?.aborted → 抛 ASK_ABORTED；questions.length===0 → EMPTY_QUESTIONS；传 agent 时 assertLiveRoot(agent)，并经 waterfall(scopeTarget(agent,agent),'user-questions/request',{...request,agent},noAnswerer)；无 answerer → NO_PROVIDER 拒绝。
- intent 仅在显式提供时校验（approve 标签必须在 options 里且 detail 必须定义，否则 BAD_INTENT）——我们可以不传 intent；intent.kind 无封闭词表，plan-review 是唯一客户端特判。
- 请求构建参考（dsh-tool-ask-user\lib\index.js:34-46）：{questions:[{id,question,header?,options?:[{label,description?}],multiSelect?}], agent?, signal}。
- 答案形状（dsh-tool-ask-user\lib\index.js:52-58 与客户端 submitDrafts 926-967 双向确认）：{answers:[{id, selected:[label...], custom?}]}；跳过的题 selected:[]。
- 客户端渲染（dsh-client-ui-user-questions\lib\client.js）：question.detail 无条件用 MarkdownText 渲染（1078-1083）；选项按钮显示 label+description+推荐徽章（1088-1133）；parseRecommendedLabel（672-681）剥掉尾部 (recommended)/(推荐)；recommendedFirstOption（683-686）仅当 options[0].label 带该后缀时预选；callId undefined 的卡片 dismiss cancel 会以 ASK_CANCELLED 拒绝 waterfall（413-422）。

### 3.5 审查流超时的合成 chunk 形状
文件：dsh-llm\lib\index.js:402-410 normalizeLlmFailure 产出 Object.freeze({message, code})。
- 合成超时 chunk 必须是 {type:'finish', reason:{kind:'error', failure:{code:'REVIEWER_TIMEOUT', message:'...'}}}（readDecision 只解构 reason.failure 的 code/message）→ readDecision 抛错 → gate 返回 failed() → 被我们的 pre-execute 监听转成用户选择。这条链同时满足需求 2。

### 3.6 schemastery 配置与 UI 原语
- z.boolean() 存在（Schema.boolean().required()，310行）；.volatile()=extra('volatile',true)（235-237），autofix 失败时回落 default（469-481）。新配置项照抄现有 volatile 模式。
- dsh-client-ui-primitives：没有现成的 boolean/select 设置字段原语（只有 SettingsFormModel.field 7352 / actions 7376），新 UI 控件必须复用 settingsTextField/settingsNumberField + 自定义 select/input（照抄 client.js 现有 protocol select 模式）。

## 四、设计方案（已定，按此实现）

### 4.1 新建 lib\review-choice.js（纯函数，可单测）
- isReviewDenial(gate)：识别三种形态——
  - denied：gate.kind==='deny' 且 gate.info?.code==='AUTO_REVIEW_DENIED'
  - failed：gate.kind==='deny' 且 /^Auto review of tool "/.test(gate.reason)
  - never-ask：gate.kind==='ask'（policy 判断在 index.js 注入侧做，这里只留纯匹配）
- reviewQuestion(exec, gate)：构建 userQuestions 请求——detail 用 Markdown 呈现工具名 + 拒绝原因（gate.info?.reason 或 gate.displayReason 或 gate.reason 全文），options 至少两项：「仍要执行（放行一次）」/「维持拒绝」；推荐项放 options[0] 且 label 带 (推荐)/(recommended) 后缀时才显示徽章。
- resolveChoice(answer, allowLabel)：从 {answers:[{id,selected,custom?}]} 提取选择；selected 含 allowLabel → 'allow'；含拒绝标签、selected 为空（跳过）或其他 → 'deny'（fail-closed）。
- withReviewDeadline(stream, timeoutMs)：async generator 包装审查流；超时未收到 finish → yield 合成 chunk（3.5 形状）并终止；timeoutMs<=0 禁用；收到真实 finish 则透传并清理定时器。

### 4.2 改 lib\index.js
- Config 新增：onBlock: z.string().default('ask').volatile()（ask 默认 | deny 保留旧行为）、reviewTimeoutMs: z.number().default(60000).volatile()（0 禁用）。
- 注册 tools/pre-execute 监听（{global:true, prepend:true}，注册顺序保障见 3.2 警告）：
  1. const gate = await next();
  2. onBlock==='deny' 或 gate 不是审查拒绝 → 原样返回 gate。
  3. 是审查拒绝（denied/failed，或 ask 且 approval effectivePolicy!=='ask'）→ ctx.userQuestions.ask({questions:[...], agent: exec.agent, signal: AbortSignal.any([exec.signal, ownController.signal])})；选择 allow → 返回 {kind:'allow'}；否则返回原 gate。
  4. 红线：NO_PROVIDER / ASK_CANCELLED / ASK_ABORTED / 空答案 / ask 抛任何错 → 一律返回原 gate（维持拒绝），绝不静默放行。exec.agent===undefined 时直接透传（无处可问）。
- llm/stream 包装处：对实际改写了路由的 reviewer 请求套 withReviewDeadline(stream, this.config.reviewTimeoutMs.get())。
- userQuestions 服务经 ctx.inject(['userQuestions'], ...) 或 ctx.get('userQuestions') 机会式获取；拿不到服务时 onBlock 自动退化为 deny（透传原 gate）。

### 4.3 改 client.js
- zh/en 字典新增：onBlock 标签+两个选项文案+hint、reviewTimeoutMs 标签+hint+单位；重写 protocolWarning（zh 在 55 行、en 在 84 行）——旧文案声称 Controversial 在 never 策略下直接拒绝，新行为是弹用户选择。
- AutoCheckCardController（111-192）：form 字段数组加 settingsTextField('onBlock')、settingsNumberField('reviewTimeoutMs')；projection() 加两个 field；selectRoute(null) 时 onBlock 重置为 ask。
- AutoCheckCard 渲染（194-417）：照抄 protocol select 模式（295-325行）加 onBlock select（props.edit('onBlock', value)），照抄 maxInputChars 模式（327-351行）加 reviewTimeoutMs number input。

### 4.4 改 README.md
- 更新第 45 行 Controversial/never 说明、第 47 行 reviewer 不可用 fail-closed 说明：现在默认弹用户选择；新增 onBlock/reviewTimeoutMs 配置说明。

### 4.5 测试
- 新建 test\review-choice.test.mjs：
  - isReviewDenial 对三种真实 gate 形状（照抄 3.1 字面量）返回 true；对普通 allow/deny/ask 返回 false。
  - resolveChoice：allow 标签→allow；拒绝标签/空 selected/未知→deny。
  - withReviewDeadline：正常流透传；卡住的流超时后产出 3.5 形状合成 finish chunk；0 禁用。
  - 端到端（模拟 waterfall 顺序）：外层监听拿 gate→问用户→allow 放行 / deny 维持 / ask 抛 NO_PROVIDER 维持原 gate。
- 现有 test\review-route.test.mjs（301行）不许改断言迁就新代码——它是回归底线。
- package.json 的 test 脚本需同时跑两个测试文件（node --test test/）。

## 五、验收标准（每条都要贴输出证据）

1. node --check lib/index.js、node --check lib/review-choice.js、node --check client.js 全过。
2. npm test 全绿（旧测试原样通过 + 新测试）。
3. gate 三形态→用户问题的转换逻辑有单测覆盖；fail-closed 红线（ask 失败=维持拒绝）有单测覆盖。
4. 超时链有单测：卡住的 reviewer 流→合成 REVIEWER_TIMEOUT finish→readDecision 抛错路径可用（直接测 chunk 形状 + withReviewDeadline 行为）。
5. client.js 新控件与字典 zh/en 对称；protocolWarning 旧文案已替换。
6. README 与实际行为一致。
7. 注册顺序（我们在 gate 外层）有验证手段：单测模拟或代码注释说明依据（cordis register unshift 语义 + 插件加载顺序），不能只写「应该没问题」。

## 六、红线（碰了返工）

- 绝不静默放行：任何提问失败/无通道/取消/空答案 → 维持原拒绝。
- 不放宽 fail-closed：需求 2 是「交给用户选择」，不是「自动放行」。
- 不改 dsh-experimental-auto-review 宿主包本身；只在我们插件层拦截。
- 不为过测试删需求、改旧断言。

## 七、行为协议（子 agent 接手时注入）

- 每次业务修改前输出一行 [PUA-DIAGNOSIS]：事实与来源 → 下一步 → 验收信号。
- 声称完成前必须贴验证命令输出；同一子目标 2 次失败就换本质不同的方案。
- 若父代理提供了 PUA SKILL.md 的绝对路径，开工前用 Read 工具读取并按其中行为协议执行；不要用 Skill tool 加载。
