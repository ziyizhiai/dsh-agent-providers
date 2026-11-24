/**
 * The environment an agent child starts from.
 *
 * A child must not inherit every secret the harness happens to hold. The
 * harness's own subprocess seam defines the canonical rule, and this mirrors it:
 *
 * - drop every credential-shaped name (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`),
 * - drop every `DSH_*` name so harness identity never leaks implicitly,
 * - keep `PATH`, `HOME`, locale, and proxy variables so real CLIs still work.
 *
 * Anything the profile explicitly maps is merged back on top by
 * {@link module:dsh-agent-providers/transport/index} — a deliberate opt-in is
 * exactly what the scrub is supposed to preserve.
 *
 * @module dsh-agent-providers/env
 */

/** Names the harness's subprocess seam also refuses to forward. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN|AUTH|CREDENTIAL/i

/** Prefix reserved for harness-owned facts. */
export const DSH_ENV_PREFIX = 'DSH_'

/**
 * The parent environment minus credential-shaped and harness-owned names.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Record<string, string>}
 */
export function scrubbedParentEnv(source = process.env) {
  const env = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(name)) continue
    if (name.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    env[name] = value
  }
  return env
}
