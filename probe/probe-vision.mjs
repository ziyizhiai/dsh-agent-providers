/**
 * Send an image through the real ACP transport to a multimodal model and print
 * what it sees. Used to inspect a screenshot when the current Session's model
 * cannot read images.
 *
 * Usage: node probe-vision.mjs <imagePath> [modelId] [prompt]
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { resolveAgent } from '../lib/config.js'
import { createTransport } from '../lib/transport/index.js'

const IMAGE = process.argv[2]
const MODEL = process.argv[3] ?? 'opencode-go/gemini-4-argon'
const PROMPT = process.argv[4]
  ?? 'Transcribe every piece of text visible in this screenshot, preserving layout order, and describe any numbers, labels, or UI indicators. Be exhaustive and literal.'

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(IMAGE).toLowerCase()]
if (MIME === undefined) throw new Error(`unsupported image extension: ${IMAGE}`)

function credential(ref) {
  const text = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  const match = new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text)
  if (match === null) throw new Error(`credential ${ref} is not stored`)
  return match[1]
}

const profile = resolveAgent('opencode-go', {
  preset: 'opencode',
  command: '/usr/local/bin/opencode',
  connectTimeoutMs: 90_000,
  env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
})

const transport = await createTransport(profile, {
  cwd: '/root',
  credentials: { resolve: async (ref) => credential(ref) },
  resolveExecutable: async (command) => command,
  logger: { error: (message) => console.log('LOG:', message) },
})

try {
  console.log('capabilities:', [...transport.capabilities].sort().join(', '))
  const session = await transport.create({ cwd: '/root' })
  await session.selectModel(MODEL)
  console.log('model:', MODEL)

  let text = ''
  const started = Date.now()
  const outcome = await session.prompt({
    text: PROMPT,
    images: [{ mediaType: MIME, data: new Uint8Array(readFileSync(IMAGE)) }],
    onUpdate: (event) => {
      if (event.type === 'text') text += event.text
    },
  })
  console.log(`stopReason: ${outcome.stopReason} in ${Date.now() - started}ms`)
  console.log('--- answer ---')
  console.log(text.trim().slice(0, 4000))
  await session.close()
} finally {
  await transport.close('probe finished')
}
