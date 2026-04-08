import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGlobalConfig, writeGlobalConfig } from '../config'
import type { GlobalConfig } from '../../shared/types'

function preferredDefaultRoot(): string {
  const developerDir = path.join(os.homedir(), 'Developer')
  if (fs.existsSync(developerDir)) {
    return '~/Developer'
  }
  return process.cwd()
}

export function initCommand(): void {
  const config = readGlobalConfig()
  if (config.sandboxes.default) {
    process.stdout.write('pippin: default sandbox already configured\n')
    return
  }

  const root = preferredDefaultRoot()
  const nextConfig: GlobalConfig = {
    portRangeStart: config.portRangeStart,
    sandboxes: {
      ...config.sandboxes,
      default: { root },
    },
  }

  writeGlobalConfig(nextConfig)
  process.stdout.write(`pippin: configured default sandbox with root ${root}\n`)
}

export const __test__ = {
  preferredDefaultRoot,
}
