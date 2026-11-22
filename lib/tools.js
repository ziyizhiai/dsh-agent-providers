/**
 * The model-facing session tool.
 *
 * A conversation driven by an external agent can still ask for its own
 * session inventory, branch itself, or release a stale conversation — the same
 * operations the sidebar panel offers a human.
 *
 * The default target is always the **calling** conversation's bound agent
 * session, so the destructive actions require an explicit route plus session
 * id to reach anything else.
 *
 * @module dsh-agent-providers/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionAdminError } from './sessions.js'

/** Tool name; stable because prompts and transcripts quote it. */
export const TOOL_NAME = 'agent_sessions'

/** Format one inventory row for the model. */
function describeRoute(entry) {
  const header = `${entry.route} (${entry.displayName}) — ${entry.sessions.length} session(s)`
  if (entry.error !== undefined) return `${header}\n  unavailable: ${entry.error}`
  if (entry.sessions.length === 0) {
    const canList = entry.capabilities.includes('list')
    return `${header}\n  ${canList ? 'no stored sessions' : 'this backend cannot list sessions'}`
  }
  const lines = entry.sessions.slice(0, 20).map((session) => {
    const owner = session.dshSessionId === undefined ? '' : ` · bound to ${session.dshSessionId}`
    const title = session.title === undefined ? '' : ` "${session.title}"`
    const when = session.updatedAt === undefined ? '' : ` · ${session.updatedAt}`
    return `  ${session.sessionId}${title}${when}${owner}`
  })
  if (entry.sessions.length > 20) lines.push(`  … and ${entry.sessions.length - 20} more`)
  return [header, ...lines].join('\n')
}

/**
 * Resolve the route and session id an operation defaults to: the calling
 * conversation's own agent session.
 */
async function currentTarget(admin, exec) {
  const agent = exec.agent
  if (agent === undefined) {
    throw new SessionAdminError('agent_sessions needs a live agent Session', 'NO_AGENT')
  }
  const selection = agent.model?.current?.()
  const route = selection?.provider
  if (typeof route !== 'string' || route.length === 0) {
    throw new SessionAdminError('this Session has no model selection yet', 'NO_SELECTION')
  }
  if (!admin.routes().includes(route)) {
    throw new SessionAdminError(
      `this Session is driven by "${route}", which is not an agent route (agent routes: ${admin.routes().join(', ') || 'none'})`,
      'NOT_AN_AGENT',
    )
  }
  const dshSessionId = String(agent.session.id)
  return { route, dshSessionId, cwd: admin.resolveCwd(dshSessionId) }
}

/**
 * Register the tool.
 *
 * @param {any} ctx
 * @param {import('./sessions.js').SessionAdmin} admin
 * @param {string} [toolName] - registry name; the profile may rename it.
 */
export function registerTool(ctx, admin, toolName = TOOL_NAME) {
  return ctx.tools.register(defineTool({
    name: toolName,
    description: 'Inspect or manage the external agent sessions behind this harness: list stored agent conversations, branch the current one so later turns continue on the copy, or release a stale one. Listing is read-only.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'fork', 'close'],
        required: true,
        description: 'list stored agent sessions; fork the current conversation into a copy; close a session to release the agent\'s resources (its history survives).',
      },
      route: {
        type: 'string',
        description: 'Agent provider route, such as "opencode-go". Omit to use the route driving this Session.',
      },
      sessionId: {
        type: 'string',
        description: 'External session id to close. Omit to close the session bound to this conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'Human-readable result of the operation.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      switch (args.action) {
        case 'list': {
          const inventory = args.route === undefined
            ? await admin.inventory({})
            : [await admin.list(args.route, { cwd: admin.resolveCwd(undefined) })]
          if (inventory.length === 0) return { summary: 'No agent routes are configured.' }
          return { summary: inventory.map(describeRoute).join('\n\n') }
        }

        case 'fork': {
          const target = await currentTarget(admin, exec)
          if (args.route !== undefined && args.route !== target.route) {
            throw new SessionAdminError(
              `this conversation is driven by "${target.route}"; only its own session can be forked`,
              'ROUTE_MISMATCH',
            )
          }
          const result = await admin.fork({ ...target, signal: exec.signal })
          return {
            summary: `Forked the agent conversation: ${result.from} → ${result.to}. Later turns in this Session continue on ${result.to}.`,
          }
        }

        case 'close': {
          const route = args.route ?? (await currentTarget(admin, exec)).route
          const sessionId = args.sessionId ?? await boundSessionId(admin, exec, route)
          const result = await admin.close(route, sessionId, { signal: exec.signal })
          return {
            summary: `Closed agent session ${result.sessionId} on ${result.route}. The conversation history the agent stored is still there; only the live resources were released.`,
          }
        }

        default:
          throw new SessionAdminError(
            `unknown action "${String(args.action)}" (expected list, fork or close)`,
            'BAD_ACTION',
          )
      }
    },
  }))
}

/** The external session id bound to the calling conversation. */
async function boundSessionId(admin, exec, route) {
  const target = await currentTarget(admin, exec)
  if (target.route !== route) {
    throw new SessionAdminError(
      `this conversation is driven by "${target.route}", not "${route}"; name the sessionId explicitly`,
      'ROUTE_MISMATCH',
    )
  }
  const binding = await admin.registry.get(target.dshSessionId, route)
  if (binding === undefined) {
    throw new SessionAdminError('this conversation has no agent session yet', 'NO_BINDING')
  }
  return binding.externalSessionId
}
