/**
 * What the plugin reports as the context window, read from the live profile.
 *
 * Values come from the real `cordis.patch.yml` entry through the real
 * resolution and adapter path — not from a copy pasted into this script.
 */
import { readFileSync } from 'node:fs'

const yamlModule = await import('file:///usr/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml/dist/index.js')
const yaml = yamlModule.default ?? yamlModule
const { resolveAgent } = await import('../lib/config.js')
const { AgentProviderAdapter } = await import('../lib/adapter.js')
const { SessionRegistry } = await import('../lib/registry.js')

const patch = yaml.parse(readFileSync('/root/.dsh/profiles/web/cordis.patch.yml', 'utf8'))
const entry = patch.find((row) => row !== null && typeof row === 'object' && row.id === 'llm-agent-providers')
const raw = entry.config.agents['opencode-go']
const profile = resolveAgent('opencode-go', raw)
console.log('resolved: catalog=%s defaultContextWindow=%s args=%s',
  profile.catalog, profile.defaultContextWindow, JSON.stringify(profile.args))

const adapter = new AgentProviderAdapter({
  current: () => ({ profiles: new Map([['opencode-go', profile]]), maxReplayChars: 400_000 }),
  registry: new SessionRegistry('/tmp'),
  resolveCwd: () => '/root',
  credentials: {
    resolve: async (ref) => new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm')
      .exec(readFileSync('/root/.dsh/.credentials.yaml', 'utf8'))?.[1],
  },
  readImage: async () => ({ data: new Uint8Array([1]) }),
  logger: { error: () => {} },
})

const models = await adapter.listModels('opencode-go')
console.log('catalogue:', models.length, 'models')
for (const model of models.slice(0, 3)) {
  const info = await adapter.resolveModel('opencode-go', model.id)
  console.log(`${model.id}: window=${info.context.contextWindow} modalities=${model.inputModalities} badge=${JSON.stringify(model.badge)}`)
}
const hy3 = models.find((model) => model.id === 'opencode-go/hy3')
if (hy3 !== undefined) console.log('hy3 pinned?', JSON.stringify((await adapter.resolveModel('opencode-go', hy3.id)).context))
await adapter.dispose()
