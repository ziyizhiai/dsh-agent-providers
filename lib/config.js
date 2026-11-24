/**
 * Configuration schema for `dsh-agent-providers`.
 *
 * The `agents` dict key IS the provider route, so a profile layer and the
 * user-settings layer merge per agent and the route set is structural — the
 * same shape `dsh-llm-pi-ai` uses for `providers:`.
 *
 * @module dsh-agent-providers/config
 */
import z from '@deepseek-ai/schemastery'
import { PRESETS } from './presets.js'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

export function profileGeneration(profile) {
  const identity = { command: profile.command, args: profile.args, transport: profile.transport,
    env: profile.env, credentials: profile.credentials, auth: profile.auth, accountScope: profile.accountScope }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function validateEntry(route, value) {
  const fail = (field, message) => { const error = new Error(`agents.${route}.${field}: ${message}`); error.code = 'CONFIG_INVALID'; throw error }
  if (typeof route !== 'string' || !route.trim() || /[\u0000-\u001f]/.test(route)) fail('id', 'must be non-empty')
  for (const field of ['args', 'extraArgs']) if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string'))) fail(field, 'must be an array of strings')
  for (const [field, allowed] of Object.entries({ permission: ['allow', 'reject', 'ask'], continuity: ['auto', 'resume', 'replay'], catalog: ['auto', 'probe', 'declared'], format: ['text', 'jsonl'] })) {
    if (value[field] !== undefined && !allowed.includes(value[field])) fail(field, `must be ${allowed.join(' / ')}`)
  }
  for (const field of ['eventTimeoutMs', 'connectTimeoutMs', 'idleReleaseMs', 'cancelTimeoutMs', 'configWaitMs', 'maxConcurrentTurns', 'defaultContextWindow', 'defaultMaxTokens']) {
    const number = value[field]
    if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0 || (field === 'maxConcurrentTurns' && number > 16))) fail(field, 'must be a positive integer within its supported range')
  }
  for (const field of ['env', 'configOptions', 'credentials']) if (value[field] !== undefined && (!isPlainObject(value[field]))) fail(field, 'must be an object')
  if (value.env && Object.values(value.env).some(item => typeof item !== 'string')) fail('env', 'values must be strings')
  if (value.cwd && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) fail('cwd', 'must be absolute')
  if (value.models !== undefined && !Array.isArray(value.models)) fail('models', 'must be an array')
  for (const [index, model] of (value.models ?? []).entries()) {
    if (!isPlainObject(model)) fail(`models.${index}`, 'must be an object')
    for (const field of ['contextWindow', 'maxTokens']) if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field] <= 0)) fail(`models.${index}.${field}`, 'must be a positive integer')
  }
}

/** Default idle bound between two agent events inside one prompt. */
export const DEFAULT_EVENT_TIMEOUT_MS = 600_000
/** Default bound for spawn + initialize + session creation. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 120_000
/** Default warm-process idle bound. */
export const DEFAULT_IDLE_RELEASE_MS = 600_000

const modelEntry = z.object({
  /** Model id understood by the agent. */
  id: z.string().required(),
  /** Human-readable name for the model picker; defaults to the id. */
  name: z.string(),
  /** Context capacity advertised to the harness (token metering, compaction). */
  contextWindow: z.number().step(1).min(1),
  /** Output cap advertised to the harness. */
  maxTokens: z.number().step(1).min(1),
})

/** How a non-ACP CLI is started, prompted, resumed, and read. */
const cliRecipe = z.object({
  /**
   * `stdin` pipes the prompt in; `arg` appends it as the last argument.
   *
   * A preset can supply `arg`, so this must not carry a schema `default()`:
   * the materialized `'stdin'` would be indistinguishable from an explicit
   * choice and would beat the preset (the same trap the top-level fields avoid).
   * `normalizeRecipe` fills the default after the preset merge.
   */
  promptVia: z.union(['stdin', 'arg']),
  /** Arguments appended when resuming, with `{session}` substituted. */
  resumeArgs: z.array(z.string()),
  /** Dotted path in the first JSON event that carries the agent's session id. */
  sessionIdPath: z.string(),
  /** Arguments appended for a model, with `{model}` substituted. */
  modelArgs: z.array(z.string()),
  /**
   * Command whose JSON output enumerates the models the agent serves.
   *
   * A vendor CLI often knows its catalogue only after signing in (and the
   * gateway decides what an account may use), so a declared `models:` list
   * would be a copy that goes stale. The array is the whole argv — executable
   * first — because several launchers are their own enumerator behind a
   * subcommand. Without this field the declared catalogue stays authoritative.
   */
  catalogCommand: z.array(z.string()),
  /**
   * Where the catalogue command's JSON keeps the entries and their fields.
   *
   * Vendors disagree on this shape, so it is recipe data rather than code. The
   * entries and id paths are mandatory in practice (`assertCliRecipe` rejects a
   * command without them); `name` and `contextWindow` are optional and fall
   * back to the id and to the route's own defaults.
   */
  catalogJson: z.object({
    /** Dotted path of the model array in the command's JSON output. */
    entries: z.string(),
    /** Dotted path of one entry's model id — the value `modelArgs` receives. */
    id: z.string(),
    /** Dotted path of a display name; an entry without one keeps its id. */
    name: z.string(),
    /**
     * Dotted path of the context window. A gateway that publishes the real
     * window here is more trustworthy than a guess, because the harness both
     * meters and compacts against it.
     */
    contextWindow: z.string(),
  }),
  /** Bound for the catalogue command; enumerating models is not a prompt. */
  catalogTimeoutMs: z.number().step(1).min(1),
  /** Where the answer lives in each JSON line. */
  jsonl: z.object({
    text: z.string(),
    reasoning: z.string(),
    tool: z.string(),
    toolId: z.string(),
    toolStatus: z.string(),
    toolKind: z.string(),
    toolInput: z.string(),
    toolOutput: z.string(),
    model: z.string(),
    /** Dotted path marking a refusal, and the value that means "refused". */
    error: z.object({
      path: z.string(),
      equals: z.string(),
    }),
    /** Dotted paths of the input/output token counts. */
    usage: z.object({
      input: z.string(),
      output: z.string(),
      /**
       * Dotted paths of cached prompt tokens, read and written.
       *
       * The harness requires disjoint counts it can add up, so an agent that
       * reports cached prompt tokens separately publishes them here instead of
       * folding them into the input count (which `inputTokensIncludeCache`
       * covers for agents that do fold them).
       */
      cacheRead: z.string(),
      cacheWrite: z.string(),
    }),
  }),
})

/**
 * One provider route: one agent backend.
 *
 * None of these fields carries a schema `default()`: `resolveAgent` merges a
 * preset with the entry and only then applies defaults. A schema default here
 * would be materialized first and silently win over the preset it was supposed
 * to defer to — which is exactly how `opencode` once started without its `acp`
 * argument.
 */
const agentEntry = z.object({
  /** Fill defaults from a known backend before applying this entry's fields. */
  preset: z.union(Object.keys(PRESETS)),

  /** Group heading in the model picker; defaults to the preset or route key. */
  displayName: z.string(),

  /** Which protocol family drives this agent. */
  transport: z.union(['acp', 'cli']),
  /** Output format for {@link transport} `cli`. */
  format: z.union(['text', 'jsonl']),

  /**
   * Executable that starts the agent. Omitted only when a preset supplies it;
   * resolution enforces presence after the preset merge.
   */
  command: z.string(),
  /** Arguments passed to {@link command}. */
  args: z.array(z.string()),
  /** Literal environment for the child; highest precedence. */
  env: z.dict(z.string()),
  /**
   * Child environment names filled from DSH credential refs.
   *
   * Either a bare ref, whose raw value becomes the variable, or
   * `{ ref, template }` where `{value}` is replaced by the secret — the form an
   * agent needs when it reads a JSON credential *document* rather than a plain
   * key. Nothing is ever written to the profile, and nothing is written to the
   * agent's own auth store either.
   */
  credentials: z.dict(z.union([
    z.string(),
    z.object({ ref: z.string().required(), template: z.string().required() }),
  ])),
  /** Working directory override; unset follows the DSH Session's own cwd. */
  cwd: z.string(),

  /**
   * How the child's permission requests are answered.
   *
   * - `allow` answers with the first `allow_once`/`allow_always` option the
   *   agent offers (falling back to denial), never involving a human.
   * - `reject` always denies.
   * - `ask` routes the question through the harness's approval service, so it
   *   reaches the same prompt a harness tool call would. A composition without
   *   an approval service, or a question arriving outside a turn, fails closed:
   *   the tool is denied and the turn continues, instead of the agent silently
   *   doing whatever it wanted.
   */
  permission: z.union(['allow', 'reject', 'ask']),

  /**
   * How conversation state is carried between turns. The transport decides
   * whether resuming is possible at all; this only says whether to try.
   *
   * - `resume`: reattach to the stored conversation and send only new input.
   * - `replay`: start fresh every turn and replay the whole transcript.
   * - `auto`: `resume` when the transport supports it, else `replay`.
   */
  continuity: z.union(['auto', 'resume', 'replay']),

  /** Idle bound between two agent events inside one prompt. */
  eventTimeoutMs: z.number().step(1).min(1),
  /** Bound for spawn + initialize + session creation. */
  connectTimeoutMs: z.number().step(1).min(1),
  /** A warm agent process idle this long is released. */
  idleReleaseMs: z.number().step(1).min(1),
  /** Admission per provider route, shared across conversations. */
  maxConcurrentTurns: z.number().step(1).min(1).max(16),
  /** Deadline waiting for an agent to acknowledge Stop. */
  cancelTimeoutMs: z.number().step(1).min(1),

  /**
   * Session configuration applied right after a session is created or loaded,
   * keyed by config-option id (or category) — `{ effort: 'high', mode: 'plan' }`.
   * An id the agent does not publish is logged and skipped.
   */
  configWaitMs: z.number().step(1).min(1),
  /** Explicit native-account epoch; changing it invalidates warm processes and old bindings. */
  accountScope: z.string(),
  configOptions: z.dict(z.any()),
  /**
   * Sign-in parameters for an agent that refuses `session/new` until
   * `authenticate` succeeds. ACP leaves the request shape to the agent, so the
   * profile writes it verbatim; `{value}` is replaced by the credential.
   */
  auth: z.object({
    methodId: z.string(),
    ref: z.string(),
    params: z.any(),
  }),
  /**
   * Model advertised when the agent's catalogue cannot be read yet.
   *
   * An agent that needs a session to list models, and a session to list models
   * only after signing in, would otherwise present an empty group that cannot
   * be selected — leaving no way to reach the sign-in error. This placeholder
   * keeps the group selectable so the real message surfaces.
   */
  fallbackModel: z.union([z.boolean(), z.object({ id: z.string(), name: z.string() })]),
  /**
   * Context window for models this route serves that declare no `contextWindow`
   * of their own. ACP never reports a window up front, so a probe-discovered
   * catalogue would otherwise inherit a guess far below reality (200k for a 1M
   * model), and the harness would both meter and compact against the wrong
   * number.
   */
  defaultContextWindow: z.number().step(1).min(1),
  /** Output cap applied when a model declares none. */
  defaultMaxTokens: z.number().step(1).min(1),

  /**
   * Label shown beside every model of this route in the picker.
   *
   * Picking an agent-backed model looks exactly like picking a plain one, and
   * the difference matters: the agent runs its own tools and the harness's
   * approval and sandbox do not apply to it. A badge is the cheapest honest
   * signal the picker already knows how to draw.
   */
  badgeText: z.string(),
  badgeTone: z.union(['neutral', 'info', 'success', 'warning']),

  /** Write agent tool activity into the reasoning channel as breadcrumbs. */
  showToolActivity: z.boolean(),

  /**
   * Whether this agent folds cached prompt tokens into `inputTokens`.
   *
   * ACP leaves the relationship open: some agents report `inputTokens` as the
   * uncached count and the cache separately (OpenCode), others report the
   * whole prompt and the cache again (TRAE CLI). The harness requires
   * disjoint counts, so for the second kind this subtracts
   * `cachedReadTokens` + `cachedWriteTokens` from `inputTokens`.
   */
  inputTokensIncludeCache: z.boolean(),

  /**
   * Dotted path inside a catalogue entry's `_meta` where the agent reports the
   * model's context window, e.g. `trae.contextWindow`.
   *
   * ACP's model list carries ids, names and descriptions only — no window — so
   * without this a probed catalogue is metered at the route default until the
   * first `usage_update` corrects it. An agent that advertises the window on its
   * own can have it read here instead, with no vendor branch in the transport.
   */
  contextWindowMetaPath: z.string(),

  /**
   * How the advertised catalogue is built.
   *
   * - `auto` (default): the agent's own list when {@link models} is empty;
   *   otherwise the declared entries are the whole catalogue.
   * - `probe`: always ask the agent, then apply the declared entries as
   *   metadata overrides. Use this to pin a context window per model without
   *   having to re-declare every model the agent serves.
   * - `declared`: never ask the agent — the declared entries are the catalogue.
   */
  catalog: z.union(['auto', 'probe', 'declared']),
  /**
   * Per-model metadata; also the whole catalogue under `catalog: declared`.
   * `{ id, name?, contextWindow?, maxTokens? }`.
   */
  models: z.array(modelEntry),

  /** Extra raw arguments appended to the agent command line (advanced). */
  extraArgs: z.array(z.string()),

  /** Recipe for {@link transport} `cli`. */
  cli: cliRecipe,
})

/** Plugin configuration. */
export const Config = z.object({
  /** Optional explicit profile-private state root when the host lacks profileContext. */
  stateDirectory: z.string(),
  /**
   * Register the model-facing `agent_sessions` tool.
   *
   * The tool is global: every agent in the profile sees it. A deployment that
   * only wants the provider routes, or that already has a tool by this name,
   * turns it off.
   */
  exposeTool: z.boolean(),
  /** Name the tool is registered under. */
  toolName: z.string(),
  /**
   * Provider routes: dict key = route id, value = one agent backend.
   * `volatile()` makes the field hot-reloadable and gives it a live `.get()`.
   */
  agents: z.dict(agentEntry).default({}).volatile(),
  /** Replayed history is truncated to this many characters (oldest first). */
  maxReplayChars: z.number().step(1).min(1).default(400_000),
})

/** True for a plain object (not an array, not null). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Layer one nested block over another with the same "materialized emptiness
 * means not set" rule at every level.
 *
 * Only the `cli` recipe goes through this: it is the one nested block a preset
 * supplies and a profile may want to adjust in one field (a catalogue timeout,
 * a single JSON path). Every other nested field keeps the shallow semantics,
 * where an explicit value replaces the preset wholesale.
 *
 * Arrays are replaced, never merged: an argument list is an ordered sequence,
 * so interleaving two layers would produce a command line neither of them meant.
 *
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overlay
 */
function mergeLayer(base, overlay) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (value === '') continue
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) continue
      const current = merged[key]
      merged[key] = isPlainObject(current) ? mergeLayer(current, value) : value
      continue
    }
    merged[key] = value
  }
  return merged
}

/**
 * Layer the entry over its preset, treating schema-materialized emptiness as
 * "not set".
 *
 * Schemastery fills an omitted array with `[]` and an omitted dict with `{}`
 * before this function sees them, so a shallow spread would let those empty
 * containers beat the preset that was supposed to supply the value. The cost is
 * that a preset's non-empty default cannot be overridden *to* empty through
 * this field; `command` and `extraArgs` remain available for that.
 *
 * @param {Record<string, any>} preset
 * @param {Record<string, any>} raw
 */
function mergePreset(preset, raw) {
  const merged = { ...preset }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    // The schema materializes absent fields, so an empty container or an empty
    // string means "the profile said nothing" — letting it through would erase
    // the preset's value (the `args: []` / `command: ''` trap).
    if (Array.isArray(value) && value.length === 0) continue
    if (value === '') continue
    if (isPlainObject(value) && Object.keys(value).length === 0) continue
    // The recipe is a block of mostly-empty containers on a preset-only entry
    // (`resumeArgs: []`, `catalogJson: {}`, `jsonl: { error: {}, usage: {} }`),
    // so a shallow spread would replace a preset's whole recipe with nothing.
    if (key === 'cli' && isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeLayer(merged[key], value)
      continue
    }
    merged[key] = value
  }
  return merged
}

/**
 * Resolve one raw agent entry into detached, validated facts.
 *
 * @param {string} route
 * @param {any} raw
 */
export function resolveAgent(route, raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`dsh-agent-providers: agent "${route}" is not an object`)
  }
  const preset = raw.preset === undefined ? {} : PRESETS[raw.preset]
  if (raw.preset !== undefined && preset === undefined) {
    throw new Error(
      `dsh-agent-providers: agent "${route}" names unknown preset "${raw.preset}" (known: ${Object.keys(PRESETS).join(', ')})`,
    )
  }
  const merged = mergePreset(preset ?? {}, raw)
  delete merged.preset
  validateEntry(route, merged)

  const displayName = merged.displayName ?? route
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new Error(`dsh-agent-providers: agent "${route}" has an empty displayName`)
  }
  if (typeof merged.command !== 'string' || merged.command.trim().length === 0) {
    throw new Error(`dsh-agent-providers: agent "${route}" needs a non-empty command`)
  }
  const transport = merged.transport ?? 'acp'
  if (transport !== 'acp' && transport !== 'cli') {
    throw new Error(`dsh-agent-providers: agent "${route}" has unknown transport "${merged.transport}"`)
  }

  const seen = new Set()
  const models = (merged.models ?? []).map((model) => {
    if (typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error(`dsh-agent-providers: agent "${route}" has a model with an empty id`)
    }
    if (seen.has(model.id)) {
      throw new Error(`dsh-agent-providers: agent "${route}" declares model "${model.id}" twice`)
    }
    seen.add(model.id)
    return {
      id: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }
  })

  return {
    route,
    displayName,
    transport,
    format: merged.format ?? 'jsonl',
    command: merged.command,
    args: [...(merged.args ?? []), ...(merged.extraArgs ?? [])],
    env: { ...(merged.env ?? {}) },
    credentials: normalizeCredentials(route, merged.credentials ?? {}),
    ...(merged.cwd === undefined || merged.cwd.length === 0 ? {} : { cwd: merged.cwd }),
    permission: merged.permission ?? 'allow',
    continuity: merged.continuity ?? 'auto',
    eventTimeoutMs: merged.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS,
    connectTimeoutMs: merged.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    idleReleaseMs: merged.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS,
    maxConcurrentTurns: merged.maxConcurrentTurns ?? 2,
    cancelTimeoutMs: merged.cancelTimeoutMs ?? 2000,
    configWaitMs: merged.configWaitMs ?? 1000,
    accountScope: merged.accountScope ?? '',
    badgeText: merged.badgeText ?? 'Agent',
    badgeTone: merged.badgeTone ?? 'info',
    showToolActivity: merged.showToolActivity ?? true,
    inputTokensIncludeCache: merged.inputTokensIncludeCache ?? false,
    catalog: merged.catalog ?? 'auto',
    ...(merged.contextWindowMetaPath === undefined || merged.contextWindowMetaPath.length === 0
      ? {}
      : { contextWindowMetaPath: merged.contextWindowMetaPath }),
    // An `auth` block without a method is a materialized empty object, not a
    // request to sign in: forwarding it would call authenticate(undefined).
    ...(typeof merged.auth?.methodId === 'string' ? { auth: merged.auth } : {}),
    configOptions: merged.configOptions ?? {},
    fallbackModel: merged.fallbackModel ?? true,
    ...(merged.defaultContextWindow === undefined ? {} : { defaultContextWindow: merged.defaultContextWindow }),
    ...(merged.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: merged.defaultMaxTokens }),
    models,
    ...(merged.cli === undefined ? {} : { cli: normalizeRecipe(merged.cli) }),
  }
}

/** Validate every credential entry into one shape: `{ ref, template? }`. */
function normalizeCredentials(route, raw) {
  const normalized = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        throw new Error(`dsh-agent-providers: agent "${route}" maps ${name} to an empty credential ref`)
      }
      normalized[name] = { ref: entry }
      continue
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.ref !== 'string' || entry.ref.length === 0) {
      throw new Error(`dsh-agent-providers: agent "${route}" has an invalid credential entry for ${name}`)
    }
    if (typeof entry.template === 'string' && !entry.template.includes('{value}')) {
      throw new Error(
        `dsh-agent-providers: agent "${route}" credential template for ${name} has no {value} placeholder`,
      )
    }
    normalized[name] = {
      ref: entry.ref,
      ...(entry.template === undefined ? {} : { template: entry.template }),
    }
  }
  return normalized
}

/** Fill the recipe's nested defaults without inventing structure. */
function normalizeRecipe(raw) {
  // The schema materializes an omitted `catalogJson` as `{}`, exactly like
  // `jsonl.error`; forwarding that empty container would make a route look as
  // though it configured a catalogue mapping it never asked for.
  const catalogJson = raw.catalogJson ?? {}
  const mappedCatalog = ['entries', 'id', 'name', 'contextWindow']
    .filter((field) => catalogJson[field] !== undefined && catalogJson[field] !== '')
  const usage = raw.jsonl?.usage ?? {}
  return {
    promptVia: raw.promptVia ?? 'stdin',
    ...(raw.resumeArgs === undefined ? {} : { resumeArgs: [...raw.resumeArgs] }),
    ...(raw.sessionIdPath === undefined ? {} : { sessionIdPath: raw.sessionIdPath }),
    ...(raw.modelArgs === undefined ? {} : { modelArgs: [...raw.modelArgs] }),
    ...(raw.catalogCommand === undefined ? {} : { catalogCommand: [...raw.catalogCommand] }),
    ...(mappedCatalog.length === 0 ? {} : {
      catalogJson: Object.fromEntries(mappedCatalog.map((field) => [field, catalogJson[field]])),
    }),
    ...(raw.catalogTimeoutMs === undefined ? {} : { catalogTimeoutMs: raw.catalogTimeoutMs }),
    ...(raw.jsonl === undefined ? {} : {
      jsonl: {
        ...(raw.jsonl.text === undefined ? {} : { text: raw.jsonl.text }),
        ...(raw.jsonl.reasoning === undefined ? {} : { reasoning: raw.jsonl.reasoning }),
        ...(raw.jsonl.tool === undefined ? {} : { tool: raw.jsonl.tool }),
        ...Object.fromEntries(['toolId', 'toolStatus', 'toolKind', 'toolInput', 'toolOutput', 'model']
          .filter((field) => typeof raw.jsonl[field] === 'string' && raw.jsonl[field].length > 0)
          .map((field) => [field, raw.jsonl[field]])),
        ...(raw.jsonl.error === undefined ? {} : {
          error: {
            ...(raw.jsonl.error.path === undefined ? {} : { path: raw.jsonl.error.path }),
            equals: raw.jsonl.error.equals ?? 'true',
          },
        }),
        ...(raw.jsonl.usage === undefined ? {} : {
          usage: {
            input: usage.input,
            output: usage.output,
            ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
            ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
          },
        }),
      },
    }),
  }
}
