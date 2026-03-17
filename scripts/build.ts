import { $ } from 'bun'
import path from 'node:path'
import { readFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const src = path.join(root, 'src')
const dist = path.join(root, 'dist')

const args = process.argv.slice(2)
const buildServer = args.length === 0 || args.includes('--server')
const buildCli = args.length === 0 || args.includes('--cli')

// Resolve version: prefer VERSION env var (set by CI from git tag), else package.json
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')).version as string
const version = process.env.VERSION ?? pkgVersion
const defineVersion = `--define:__VERSION__=\\\"${version}\\\"`

async function buildServerBinaries() {
  const entry = path.join(src, 'server', 'index.ts')

  // Build for both Linux architectures (runs inside leash Docker container)
  const targets = ['bun-linux-x64', 'bun-linux-arm64'] as const

  for (const target of targets) {
    const arch = target.endsWith('x64') ? 'x64' : 'arm64'
    const outfile = path.join(dist, `pippin-server-linux-${arch}`)
    await $`bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv ${defineVersion} --target=${target} ${entry} --outfile ${outfile}`
  }
}

async function buildCliBinary() {
  const entry = path.join(src, 'cli', 'index.ts')

  // Build CLI for all supported host targets
  const targets = [
    'bun-darwin-arm64',
    'bun-darwin-x64',
    'bun-linux-x64',
    'bun-linux-arm64',
  ] as const

  for (const target of targets) {
    const [, platform, arch] = target.split('-')
    const outfile = path.join(dist, `pippin-${platform}-${arch}`)
    await $`bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv ${defineVersion} --target=${target} ${entry} --outfile ${outfile}`
  }
}

if (buildServer) {
  await buildServerBinaries()
}

if (buildCli) {
  await buildCliBinary()
}
