/**
 * Known backends, so the common case is a preset name plus credentials.
 *
 * A preset only fills defaults; every field it sets can be overridden in the
 * profile. Anything not listed here is still usable by writing the fields out.
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
    credentials: {
      OPENCODE_AUTH_CONTENT: {
        ref: 'CUSTOM_OPENCODE_API_KEY',
        template: '{"opencode-go":{"type":"api","key":"{value}"}}',
      },
    },
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
  },
  /** A headless CLI with no ACP support; the recipe makes it usable as-is. */
  'cli-jsonl': {
    displayName: 'CLI agent',
    transport: 'cli',
    format: 'jsonl',
  },
})
