/**
 * Link the host's own DSH packages into this package so the test suite can run
 * straight from a checkout, without publishing or installing anything.
 *
 * The plugin itself declares these as peer dependencies; this script only makes
 * them resolvable for `node --test` on a machine that already has DSH installed.
 *
 *   node scripts/link-dsh.mjs            # link from $DSH_INSTALL_DIR
 *   node scripts/link-dsh.mjs /path/to/node_modules
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const installDir = process.argv[2]
  ?? process.env.DSH_INSTALL_DIR
  ?? '/usr/lib/node_modules/@deepseek-ai/dsh'
const modules = join(installDir, 'node_modules')

const wanted = [
  '@agentclientprotocol/sdk',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

if (!existsSync(modules)) {
  console.error(`link-dsh: ${modules} does not exist; pass the DSH node_modules root as an argument`)
  process.exit(1)
}

for (const name of wanted) {
  const source = join(modules, name)
  if (!existsSync(source)) {
    console.error(`link-dsh: skip ${name} (not installed in ${modules})`)
    continue
  }
  const target = join(here, 'node_modules', name)
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  symlinkSync(resolve(source), target, 'junction')
  console.log(`link-dsh: ${name} -> ${resolve(source)}`)
}
