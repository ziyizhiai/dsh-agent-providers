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
  'claude-code': {
    displayName: 'Claude Code',
    transport: 'acp',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  codex: {
    displayName: 'Codex',
    transport: 'acp',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
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
