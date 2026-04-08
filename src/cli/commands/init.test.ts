import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('init command', () => {
  let tmpDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-init-')))
    vi.stubEnv('HOME', tmpDir)
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a default sandbox rooted at ~/Developer when present', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Developer'), { recursive: true })
    const v = Date.now()
    const { initCommand } = await import(/* @vite-ignore */ `./init.ts?v=${v}`)
    const { readGlobalConfig } = await import(/* @vite-ignore */ `../config.ts?v=${v}`)

    initCommand()

    expect(readGlobalConfig().sandboxes.default?.root).toBe('~/Developer')
  })

  it('does not overwrite an existing default sandbox', async () => {
    const configDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      sandboxes: {
        default: { root: '/existing' },
      },
    }))

    const v = Date.now()
    const { initCommand } = await import(/* @vite-ignore */ `./init.ts?v=${v}`)
    const { readGlobalConfig } = await import(/* @vite-ignore */ `../config.ts?v=${v}`)
    initCommand()

    expect(readGlobalConfig().sandboxes.default?.root).toBe('/existing')
    expect(stdoutSpy).toHaveBeenCalledWith('pippin: default sandbox already configured\n')
  })
})
