# 如何接入一个新的 agent（transport 契约）

这份文档只讲一件事：**当你想再接一个 agent（比如 traex 的命令行模式），要写多少代码。**

答案分三档，从「只改配置」到「写一个 transport」。

---

## 契约在哪里

```
lib/transport/contract.js   接口定义 + 能力位 + 归一化事件 + 断言
lib/transport/acp.js        ACP 实现（完整能力）
lib/transport/cli.js        配置驱动的一次性 CLI 实现（缩减能力）
lib/transport/index.js      工厂：profile.transport → 实现
```

适配器（`lib/adapter.js`）**只认这两个接口**，不知道 ACP 是什么。

```js
/**
 * @typedef {object} AgentTransport
 * @property {string} kind
 * @property {ReadonlySet<string>} capabilities
 * @property {(o: { cwd, signal? }) => Promise<{id, name, description?}[]>} catalog
 * @property {(o: { cwd, signal? }) => Promise<AgentSession>} create
 * @property {(id, o: { cwd, signal? }) => Promise<AgentSession>} resume
 * @property {(o: { cwd, signal? }) => Promise<object[]>} list
 * @property {(reason?: string) => Promise<void>} close
 */

/**
 * @typedef {object} AgentSession
 * @property {string}   externalId
 * @property {boolean}  resumed
 * @property {ReadonlySet<string>} capabilities
 * @property {(modelId, o: { signal? }) => Promise<void>} selectModel
 * @property {(r: { text, images?, onUpdate?, signal? }) => Promise<{stopReason, usage?}>} prompt
 * @property {(reason?: string) => Promise<void>} close
 */
```

日志式输出只有这七种事件（`AgentUpdate`）：

```js
{ type: 'text', text }
{ type: 'reasoning', text }
{ type: 'tool', title, status }        // started | completed | failed
{ type: 'plan', text }
{ type: 'title', title }
{ type: 'model', value }
{ type: 'raw', payload }               // 适配器忽略，留给以后的面板
```

只要你的 agent 能吐这七种事件，它就是一个合格的 transport。

---

## 三档工作量

### 第 0 档：agent 讲 ACP → 只写配置

```yaml
agents:
  trae:
    preset: traex        # 展开为 transport: acp、command: traex、args: ['acp', 'serve']
```

如果它还需要一个密钥，而 DSH 里已经存过（比如企业版 PAT 的
`TRAECLI_PERSONAL_ACCESS_TOKEN`），映射一个凭据引用即可：

```yaml
    credentials: { TRAECLI_PERSONAL_ACCESS_TOKEN: TRAECLI_PERSONAL_ACCESS_TOKEN }   # 子进程变量名: DSH 凭据引用名
```

**改动量：0 行代码。** 前提是它有 ACP 模式——目前 opencode / Claude Code / Codex /
TRAE CLI（`traex acp serve`）/ Gemini CLI / Goose / Cursor 都有。注意 `traex acp` 只是子命令组，
写成 `args: ['acp']` 只会拿到帮助输出。

### 第 1 档：一次性 CLI + JSON 行输出 → 写一个 recipe

```yaml
agents:
  my-agent:                                # 举例：一个没有 ACP、只会吐 JSON 行的 CLI
    transport: cli
    format: jsonl
    command: my-agent
    args: ['run']
    models:
      - { id: my-agent-fast, name: My Agent Fast, contextWindow: 128000 }
    cli:
      promptVia: stdin                       # stdin | arg
      resumeArgs: ['--continue', '{session}'] # 有这两项才点亮 RESUME
      sessionIdPath: session_id               # 第一行 JSON 里会话 id 的路径
      modelArgs: ['--model', '{model}']
      catalogCommand: ['my-agent', 'models', '--json']  # 目录命令：模型表让 agent 自己报
      catalogJson: { entries: models, id: id, name: name, contextWindow: context_length }
      catalogTimeoutMs: 20000                # 目录命令的超时，默认 20000
      jsonl:
        text: message.content                 # 点号路径
        reasoning: message.reasoning
        tool: message.tool
        error: { path: is_error, equals: 'true' }
        usage:                                # cacheRead / cacheWrite 可选
          input: usage.input_tokens
          output: usage.output_tokens
          cacheRead: usage.cache_read_input_tokens
          cacheWrite: usage.cache_creation_input_tokens
```

**改动量：0 行代码**，只要它的输出长得像「每行一个 JSON」。能力位会诚实地降级：
没有 `resumeArgs` 就不点亮 `RESUME`，于是每轮都全量重放；没有 `list`，DSH 里就
只能靠 DSH 自己的会话列表管。

#### 目录命令：让 CLI 自己报模型表

`models:` 是静态表；如果 agent 自己知道账号相关（或网关下发）的模型表，用 `catalogCommand`
让 `catalog()` 去问它：

- `catalogCommand`：非空 argv 数组。transport 用 `spawn(argv[0], argv.slice(1))` 跑它，抓
  stdout（上限约 1 MiB）和 stderr 尾部；`options.signal` 中断时会杀掉子进程。
- `catalogTimeoutMs`：超时上限，默认 `DEFAULT_CATALOG_TIMEOUT_MS = 20000`；超时拒绝并点名命令。
- 退出码非 0：拒绝，带上命令名和 stderr 尾部。
- stdout 先严格按 JSON 解析；失败时再从第一个 `{` 到最后一个 `}` 切一段重试；仍失败就点名命令
  拒绝。这样命令在 JSON 前后混了少量输出也还能读。
- `catalogJson` 指定取值路径：`entries` 必须是数组，否则拒绝；每个条目的 `id` 必须是非空字符串
  （否则跳过该条）；`name` 在配了 `catalogJson.name` 且取到非空字符串时用它的值，否则用 id；
  `contextWindow` 在 `catalogJson.contextWindow` 给出有限且 > 0 的数时采用。
- 按 id 去重（先出现者胜），保留源顺序。
- 没有 `catalogCommand`：维持原行为——声明的 `models:` 就是目录。
- 加载期校验（`assertCliRecipe`）：有 `catalogCommand` 却没有 `catalogJson.entries` / `.id`、
  有 `catalogJson` 却没有 `catalogCommand`、有 `catalogTimeoutMs` 却没有 `catalogCommand`，都在
  加载时报 `dsh-agent-providers: agent "<route>" …`。

实测例子（`aiden-claude` 预设）：`aiden x models --claude --json` 在 stdout 上只吐纯 JSON，
形状是 `{ schema_version, source, fetched_at, models: [ { cli_type, id, series, alias,
context_length, quota, ptu, capacity, status } ] }`（实测 7 个），它自己的
`- Check user login status...` 转圈提示在 stderr。每个 `id` 正是 `--model` 接受的值，
`context_length` 是网关的权威窗口（`ark-deepseek-v4.1-flash-1017` → 936000），所以那一项就是
`catalogJson: { entries: 'models', id: 'id', contextWindow: 'context_length' }`。有了这条缝，
`cli` 路由的上下文窗口不用靠 `defaultContextWindow` 猜。

#### 缓存 token 的用量字段

`jsonl.usage` 除 `input` / `output` 外还有两个可选路径 `cacheRead` / `cacheWrite`，映射成
`{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }`；缓存字段只在计数 > 0 时
带出。harness 要求计数互斥，所以：

- 报**未缓存**输入的 agent 直接映射即可——Claude Code 就是这样：`usage.input_tokens` 与
  `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` 并列，所以
  `aiden-claude` 不需要 `inputTokensIncludeCache`；
- 把缓存折进 `inputTokens` 的 agent 走 ACP 的 `inputTokensIncludeCache`（不是 CLI recipe 的字段）；
- `jsonl.usage` 配了 `cacheRead` / `cacheWrite` 却缺 `input` / `output`，在加载期报错。

### 第 2 档：输出结构 recipe 表达不了 → 写一个 transport

比如 agent 用 SSE、用私有二进制协议、或者需要常驻连接池。复制
`lib/transport/cli.js`（约 200 行）改 `prompt()` 里的解析部分即可，然后在
`lib/transport/index.js` 的 `switch` 里加一个 case。

**改动量：1 个新文件 + 1 个 case。** 适配器、配置 schema、测试框架都不动。

---

## 加 transport 时必须做的事

1. `capabilities` 说实话。适配器靠它决定降级方式：
   - 没有 `RESUME` → 每轮新会话 + 全量重放，并且不写会话绑定
   - 没有 `SWITCH_MODEL` → 换模型等于换会话
   - 没有 `IMAGES` → 图片降级成文字说明
   - 没有 `LIST` → `list()` 直接返回 `[]`
2. `prompt()` 只能在**回合结束时** resolve，并且要同步调用 `onUpdate`。
3. `signal` 中断要在合理时间内 settle（ACP 用 `session/cancel` + 进程兜底）。
4. 错误要带可执行的诊断（子进程 stderr 尾几行），不要只抛 "failed"。
5. 复用 `test/conformance.mjs` 里的 `runTransportConformance`：

```js
test('satisfies the transport contract', async (t) => {
  await runTransportConformance({ ...t, cwd }, {
    makeTransport: () => new MyTransport(profile, cwd, {}),
    capabilities: { resume: true, list: false },
  })
})
```

这套断言对 ACP ≤ 和 CLI 都跑过，新 transport 直接复用，不用自己重新想测什么。

---

## 已经踩过的坑（写在契约里免得再踩）

| 坑 | 结论 |
|---|---|
| ACP v1 没有 `session/set_model` | 换模型走 `session/set_config_option`，`category: 'model'` 的那个 select |
| `session/cancel` 是通知不是请求 | 用 `agent.notify(...)`，用 `request` 会永远等不到回复 |
| `session/load` 会把整个历史推回来 | 主动丢弃，否则 DSH 会话里每条消息都重复 |
| `PlanEntry` 缺 `priority`/`status` 会被 SDK 静默丢掉 | 发 plan 时三个字段都要给 |
| 失败的 CLI 常常 exit 0 | 必须提供 `jsonl.error` 路径，否则会当成功 |
| 目录命令的输出混进日志行 | 约定 stdout 只放 JSON；解析失败会从第一个 `{` 到最后一个 `}` 再试一次，仍失败就点名命令报错 |
| CLI 自己报的 `modelUsage.contextWindow` 是通用值 | 实测 Aiden 一律 `1e6`；用它计量会错，让目录命令在 `catalogJson.contextWindow` 里给权威窗口 |
| 完整消息事件又把正文吐一遍 | 只映射增量（如 Aiden 的 `stream_event`）；映射 `assistant` 这类完整消息会让答案重复两遍 |
| CLI 的会话能力常常只有 resume | 没有 list / fork / delete；不广告 `SWITCH_MODEL` 时换模型等于新会话 + 重放 |
| 子进程退出码非 0 但 stdio 已关 | 先读完流再等 `exit`，两件事都要做 |
