# 如何接入一个新的 agent（transport 契约）

这份文档只讲一件事：**当你想再接一个 agent（比如 trae 命令行模式），要写多少代码。**

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
    transport: acp
    command: trae
    args: ['acp']
```

如果它还需要一个密钥，而 DSH 里已经存过（比如 `TRAE_API_KEY`）：

```yaml
    credentials: { TRAE_API_KEY: TRAE_API_KEY }   # 子进程变量名: DSH 凭据引用名
```

**改动量：0 行代码。** 前提是它有 ACP 模式——目前 opencode / Claude Code / Codex / Gemini CLI / Goose / Cursor 都有。

### 第 1 档：一次性 CLI + JSON 行输出 → 写一个 recipe

```yaml
agents:
  trae:
    transport: cli
    format: jsonl
    command: trae
    args: ['run']
    models:
      - { id: trae-fast, name: Trae Fast, contextWindow: 128000 }
    cli:
      promptVia: stdin                       # stdin | arg
      resumeArgs: ['--continue', '{session}'] # 有这两项才点亮 RESUME
      sessionIdPath: session_id               # 第一行 JSON 里会话 id 的路径
      modelArgs: ['--model', '{model}']
      jsonl:
        text: message.content                 # 点号路径
        reasoning: message.reasoning
        tool: message.tool
        error: { path: is_error, equals: 'true' }
        usage: { input: usage.input_tokens, output: usage.output_tokens }
```

**改动量：0 行代码**，只要它的输出长得像「每行一个 JSON」。能力位会诚实地降级：
没有 `resumeArgs` 就不点亮 `RESUME`，于是每轮都全量重放；没有 `list`，DSH 里就
只能靠 DSH 自己的会话列表管。

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
| 子进程退出码非 0 但 stdio 已关 | 先读完流再等 `exit`，两件事都要做 |
