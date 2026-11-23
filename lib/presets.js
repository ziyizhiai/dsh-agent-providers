/**
 * Known backends, so the common case is a preset name plus credentials.
 *
 * A preset only fills defaults; every field it sets can be overridden in the
 * profile. Anything not listed here is still usable by writing the fields out.
 *
 * Every ACP preset here ships `permission: 'ask'`: these agents ask the client
 * before they touch files or run commands, and forwarding that question to the
 * harness approval service is what makes the prompt appear where a harness tool
 * call would. A route that resolves permission itself (`allow`/`reject`) and an
 * unattended deployment (no answerer → fail closed) override the field; the
 * plugin default for a hand-written route stays `allow`.
 */
export const PRESETS = Object.freeze({
  /**
   * OpenCode's own ACP server. It reports `loadSession`, `list`, `fork`,
   * `resume`, `close` and image prompts.
   *
   * The credential is a JSON *document*, not a bare key: OpenCode's ACP server
   * lists subscription models from `OPENCODE_API_KEY`, but its inference path
   * authenticates from the credential document in its auth store — with only
   * the environment var it answers every prompt with `Invalid credential`.
   * `OPENCODE_AUTH_CONTENT` supplies that document per process instead, so the
   * user's own `auth.json` is never written.
   */
  opencode: {
    displayName: 'OpenCode',
    transport: 'acp',
    command: 'opencode',
    args: ['acp'],
    // Measured in its ACP server: it calls `connection.requestPermission`
    // before a gated tool and answers `reject` outright when the client offers
    // no permission method, so the question has to reach the user.
    permission: 'ask',
    credentials: {
      OPENCODE_AUTH_CONTENT: {
        ref: 'CUSTOM_OPENCODE_API_KEY',
        template: '{"opencode-go":{"type":"api","key":"{value}"}}',
      },
    },
  },
  /**
   * OpenCode **v2** (`opencode2`, verified against 2.3.2), which is a different
   * binary and a different auth story from `opencode` above:
   *
   * - Its ACP server is also `acp`, so only the command differs.
   * - It authenticates from its own store (`~/.local/share/opencode/auth.json`,
   *   providers there today: `deepseek`, `gateway`, `opencode-go`). There is no
   *   credential *document* trap to work around, so nothing is mapped from the
   *   harness credential store — which also means this preset does not fail on a
   *   machine that has no `CUSTOM_OPENCODE_API_KEY` stored, unlike `opencode`.
   * - Its usage already reports disjoint counts (measured: `inputTokens` 69
   *   beside `cacheReadTokens` 59344), so `inputTokensIncludeCache` stays off.
   * - Models are provider-qualified and read from the account (49 here:
   *   `deepseek/deepseek-v4-flash`, `gateway/gpt-5.5`, `opencode-go/claude-haiku-5-5`, …).
   * - Permissions: when its own config asks (e.g. `{"permission":{"edit":"ask"}}`)
   *   it sends `session/request_permission` with `allow_once` / `allow_always` /
   *   `reject_once` and the target path as the tool title, which is exactly what
   *   `ask` forwards. Out of the box it auto-allows, so no prompt appears until
   *   its config says otherwise.
   * - It sends `usage_update` (`size` 1048576 for the default model here), so the
   *   window is learnt at runtime.
   */
  opencode2: {
    displayName: 'OpenCode v2',
    transport: 'acp',
    command: 'opencode2',
    args: ['acp'],
    permission: 'ask',
  },
  /**
   * Claude Code through its official ACP adapter (verified against 0.109.1).
   *
   * It advertises `list`, `fork`, `resume`, `close`, `delete`, `title` and
   * image prompts, and publishes five config options: `model`, `effort`,
   * `fast`, `ultracode`, and `mode`. The model values are the CLI's own aliases
   * (`default`, `opus`, `fable`, `sonnet`, `haiku`), not full model ids.
   *
   * It needs no `authenticate` call — it reads `ANTHROPIC_API_KEY` (or a stored
   * login) — so a missing credential surfaces on the first prompt.
   */
  'claude-code': {
    displayName: 'Claude Code',
    transport: 'acp',
    command: 'claude-agent-acp',
    permission: 'ask',
    credentials: { ANTHROPIC_API_KEY: { ref: 'ANTHROPIC_API_KEY' } },
    models: [
      { id: 'default', name: 'Default' },
      { id: 'opus', name: 'Opus' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'haiku', name: 'Haiku' },
      { id: 'fable', name: 'Fable' },
    ],
  },
  /**
   * Codex through its official ACP adapter (verified against 2.9.0).
   *
   * It refuses `session/new` until `authenticate` succeeds, and offers
   * `api-key` and `chat-gpt`. The request shape below is the one its own
   * source reads (`authRequest._meta['api-key'].apiKey`, falling back to the
   * environment). Its model list comes from the signed-in account, so it can
   * only be discovered after signing in — the catalogue is probed, with a
   * placeholder model so the group stays selectable until then.
   */
  codex: {
    displayName: 'Codex',
    transport: 'acp',
    command: 'codex-acp',
    permission: 'ask',
    auth: {
      methodId: 'api-key',
      ref: 'OPENAI_API_KEY',
      params: { _meta: { 'api-key': { apiKey: '{value}' } } },
    },
    catalog: 'probe',
  },
  gemini: {
    displayName: 'Gemini CLI',
    transport: 'acp',
    command: 'gemini',
    args: ['--acp'],
    permission: 'ask',
  },
  /**
   * TRAE CLI (`traex`, verified against traecli 0.216.0) through the ACP server
   * it ships. `acp` is a subcommand *group*, so the server itself needs
   * `acp serve` — `traex acp` alone only prints help.
   *
   * It advertises `loadSession`, image and embedded-context prompts, and
   * `sessionCapabilities` `list` / `fork` / `resume` / `close` (no `delete`),
   * plus four session config options: `model`, `mode` (`default`, `plan`,
   * `auto`, `bypass_permissions`), `collaboration_mode`, and
   * `reasoning_effort` (`low`…`max`). Models come from the signed-in account,
   * and each one carries its own window in `_meta.trae.contextWindow`; the
   * agent also sends `usage_update`, so the harness learns the real window at
   * runtime instead of trusting a guess.
   *
   * No credential is mapped: it signs in through its own store
   * (`~/.trae/traecli.toml`) via `traex login`, and reusing that is the whole
   * point. An enterprise Personal Access Token arrives as
   * `TRAECLI_PERSONAL_ACCESS_TOKEN`, which a profile can map from a stored
   * credential when there is no interactive login
   * (`credentials: { TRAECLI_PERSONAL_ACCESS_TOKEN: { ref: … } }`).
   *
   * `inputTokensIncludeCache` is the one usage adaptation it needs: measured
   * usage folds cache read **and** write into `inputTokens` (one turn: input
   * 49394 = 24624 read + 24764 write + 6 new), while the harness requires
   * disjoint counts.
   *
   * Two more fields point it at the harness's own seams:
   *
   * - `contextWindowMetaPath` reads the per-model window it already advertises
   *   (`_meta.trae.contextWindow`, 116k–1M), so the meter is right from the
   *   first turn instead of waiting for `usage_update`.
   * - `permission: 'ask'` forwards its own permission requests to the DSH
   *   approval service, so a write it wants to make surfaces in the same prompt
   *   a harness tool call would instead of being auto-approved.
   */
  traex: {
    displayName: 'TRAE CLI',
    transport: 'acp',
    command: 'traex',
    args: ['acp', 'serve'],
    inputTokensIncludeCache: true,
    contextWindowMetaPath: 'trae.contextWindow',
    permission: 'ask',
  },
  /**
   * Claude Code behind the company-internal Aiden launcher (`aiden x claude`,
   * measured against aiden 2.0.6 / Claude Code 2.1.328 on 2026-11-23).
   *
   * Aiden is a launcher, not a protocol: it owns the gateway
   * (`aiden-aiproxy.bytedance.net`), injects the JWT/api-key shim Claude Code
   * needs, and asks the user to pick a gateway model at startup. It cannot
   * speak ACP, so the `cli` recipe drives it one process per turn instead.
   *
   * - **Catalogue** — `aiden x models --claude --json` prints pure JSON on
   *   stdout (its login spinner goes to stderr) as
   *   `{ models: [{ id, context_length, … }] }`. `id` is exactly what `--model`
   *   accepts, and the gateway's `context_length` (936k for
   *   `ark-deepseek-v4.1-flash-1017`) is the authoritative window — Claude
   *   Code's own `modelUsage.contextWindow` reports a generic 1M, so metering
   *   follows the catalogue instead. The list is live per account, hence a
   *   command rather than a declared copy.
   * - **Turn** — `--print --output-format stream-json --verbose
   *   --include-partial-messages` gives JSONL on stdout and keeps Aiden's
   *   progress noise on stderr. Text arrives as `stream_event` deltas at
   *   `event.delta.text`, thinking at `event.delta.thinking`, and tool names at
   *   `event.content_block.name`; the recurring `assistant` events repeat the
   *   whole message, so they are deliberately unmapped or every answer would be
   *   duplicated.
   * - **Usage** — `result` carries `usage.input_tokens` (already uncached),
   *   `output_tokens`, and the cache read/write counters, which map to disjoint
   *   harness counts without any subtraction (`inputTokensIncludeCache` stays
   *   off).
   * - **Sessions** — `session_id` appears on the early `system:init` event and
   *   `--resume <id>` continues the same conversation through Claude Code's own
   *   session files. There is no ACP list/fork/delete, and no in-session model
   *   switch: changing the model starts a new session and replays the
   *   transcript.
   * - **Credentials** — nothing is mapped. Aiden signs in to ByteCloud itself
   *   and reuses the token store under `HOME`, which the transport's environment
   *   scrub preserves; it drops credential-shaped names (`*_KEY`, `*_TOKEN`,
   *   `*_SECRET`) but Aiden reads its own store, not the environment. Reusing
   *   that sign-in is the point of going through Aiden at all.
   * - **Permissions** — a CLI route has no DSH approval channel, so the flags
   *   are the only permission control. Print mode otherwise denies every gated
   *   tool (`Claude requested permissions to write to …`), which makes the agent
   *   useless for editing; `--permission-mode acceptEdits` lets file edits
   *   through while other gated tools stay denied. Widen further only
   *   deliberately, via `args`/`extraArgs` (for example
   *   `--dangerously-skip-permissions`).
   */
  'aiden-claude': {
    displayName: 'Aiden Claude',
    transport: 'cli',
    command: 'aiden',
    args: [
      'x', 'claude',
      '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
    ],
    format: 'jsonl',
    cli: {
      promptVia: 'arg',
      // Aiden owns `--model`: it rejects a passthrough one because the gateway
      // model it selected must win, so the model goes through its own flag.
      modelArgs: ['--model', '{model}'],
      resumeArgs: ['--resume', '{session}'],
      sessionIdPath: 'session_id',
      catalogCommand: ['aiden', 'x', 'models', '--claude', '--json'],
      catalogJson: { entries: 'models', id: 'id', contextWindow: 'context_length' },
      jsonl: {
        text: 'event.delta.text',
        reasoning: 'event.delta.thinking',
        tool: 'event.content_block.name',
        usage: {
          input: 'usage.input_tokens',
          output: 'usage.output_tokens',
          cacheRead: 'usage.cache_read_input_tokens',
          cacheWrite: 'usage.cache_creation_input_tokens',
        },
        error: { path: 'is_error', equals: 'true' },
      },
    },
  },
  /** A headless CLI with no ACP support; the recipe makes it usable as-is. */
  'cli-jsonl': {
    displayName: 'CLI agent',
    transport: 'cli',
    format: 'jsonl',
  },
})
