import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { expandHome } from './config'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

describe('expandHome', () => {
  it('expands ~ to the home directory', () => {
    expect(expandHome('~/Developer')).toBe(`${os.homedir()}/Developer`)
  })

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/usr/local/bin')).toBe('/usr/local/bin')
  })
})

describe('readGlobalConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-cfg-')))
    vi.stubEnv('HOME', tmpDir)
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns defaults when no config file exists', async () => {
    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const config = readGlobalConfig()
    expect(config.portRangeStart).toBe(9111)
    expect(config.sandboxes).toEqual({})
  })

  it('parses sandbox entries', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
      sandboxes: {
        default: { root: '~/Developer', idle_timeout: 300 },
        work: { root: '/tmp/work', image: 'custom:latest' },
      },
    }))

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.sandboxes.default.root).toBe('~/Developer')
    expect(cfg.sandboxes.default.idle_timeout).toBe(300)
    expect(cfg.sandboxes.work.image).toBe('custom:latest')
  })
})
