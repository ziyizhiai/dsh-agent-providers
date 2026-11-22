/**
 * Transport selection and construction.
 *
 * The only place that knows which protocols exist. Adding a backend means one
 * new case here plus one new module; the adapter, the config schema, and the
 * UI stay untouched.
 *
 * @module dsh-agent-providers/transport
 */
import { AcpTransport } from './acp.js'
import { CliTransport, assertCliRecipe } from './cli.js'

export { CAPABILITY, STOP_REASON, TransportContractError, supports } from './contract.js'

/**
 * Resolve one configured command to an absolute path, keeping the raw value
 * when the harness has no resolver or cannot find it (the spawn then reports a
 * normal ENOENT with the command the user wrote).
 */
async function resolveCommand(command, resolveExecutable) {
  if (resolveExecutable === undefined) return command
  try {
    const resolved = await resolveExecutable(command)
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : command
  } catch {
    return command
  }
}

/**
 * Merge the child environment for one transport instance.
 *
 * Order, lowest to highest precedence: the scrubbed process environment, the
 * credentials this profile resolves by reference, then the profile's literal
 * `env`. The credential layer exists so an agent can reuse a secret DSH already
 * stores (for example the `opencode` subscription key) without the user typing
 * it a second time, and without it ever entering the profile file.
 *
 * A template turns one stored secret into whatever shape the agent reads — for
 * example OpenCode's ACP server ignores `OPENCODE_API_KEY` for inference and
 * reads a JSON credential document, which `OPENCODE_AUTH_CONTENT` supplies
 * without touching the agent's own auth store on disk.
 *
 * @param {any} profile
 * @param {{ resolve: (ref: string) => Promise<string | undefined> }} credentials
 * @returns {Promise<Record<string, string>>}
 */
async function resolveEnv(profile, credentials) {
  const env = {}
  for (const [childName, entry] of Object.entries(profile.credentials ?? {})) {
    // A resolved profile always carries `{ ref, template? }`; accept a bare ref
    // too so a hand-built profile in a test or a probe keeps working.
    const ref = typeof entry === 'string' ? entry : entry.ref
    const template = typeof entry === 'string' ? undefined : entry.template
    const value = await credentials.resolve(ref)
    if (value === undefined || value.length === 0) {
      throw new Error(
        `dsh-agent-providers: agent "${profile.route}" needs credential "${ref}"`
          + `${ref === childName ? '' : ` for ${childName}`}, but no value is stored`,
      )
    }
    env[childName] = template === undefined ? value : template.split('{value}').join(value)
  }
  return { ...env, ...profile.env }
}

/**
 * Build and start one transport for one (route, cwd) pair.
 *
 * @param {any} profile - a resolved agent profile.
 * @param {object} options
 * @param {string} options.cwd
 * @param {{ resolve: (ref: string) => Promise<string | undefined> }} options.credentials
 * @param {{ error?: (...args: any[]) => void }} [options.logger]
 */
export async function createTransport(profile, { cwd, credentials, logger, resolveExecutable, diagnostics }) {
  const env = await resolveEnv(profile, credentials)
  const resolved = { ...profile, env: { ...profile.env, ...env } }

  switch (resolved.transport) {
    case 'acp': {
      // Resolve the executable through the harness so a profile's PATH is not
      // the only thing standing between a configured agent and a spawn.
      const executable = await resolveCommand(resolved.command, resolveExecutable)
      const transport = new AcpTransport({ ...resolved, executable }, cwd, { logger, credentials })
      try {
        await transport.start()
      } catch (error) {
        // A cold-start failure is the hardest thing to debug from the browser,
        // so record exactly what was launched before rethrowing.
        await diagnostics?.record({ ...transport.diagnostics(), error: error.message }).catch?.(() => {})
        await transport.close()
        throw error
      }
      return transport
    }
    case 'cli': {
      assertCliRecipe(resolved.route, resolved)
      const executable = await resolveCommand(resolved.command, resolveExecutable)
      return new CliTransport({ ...resolved, executable }, cwd, { logger })
    }
    default:
      throw new Error(
        `dsh-agent-providers: agent "${resolved.route}" names unknown transport "${resolved.transport}" (expected "acp" or "cli")`,
      )
  }
}
