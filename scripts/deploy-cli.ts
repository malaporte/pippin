import { $ } from 'bun'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dist = path.resolve(import.meta.dirname, '..', 'dist')
const source = path.join(dist, 'pippin')
const installDir = path.join(os.homedir(), '.local', 'bin')
const dest = path.join(installDir, 'pippin')

// Build first
await $`bun run ${path.join(import.meta.dirname, 'build.ts')} --cli`

// Ensure install directory exists
fs.mkdirSync(installDir, { recursive: true })

// Copy binary
fs.copyFileSync(source, dest)
fs.chmodSync(dest, 0o755)

process.stderr.write(`installed pippin to ${dest}\n`)

// Check if install dir is on PATH
const pathDirs = (process.env.PATH || '').split(':')
if (!pathDirs.includes(installDir)) {
  process.stderr.write(`\nwarning: ${installDir} is not on your PATH\n`)
  process.stderr.write(`add it with: export PATH="${installDir}:$PATH"\n`)
}
