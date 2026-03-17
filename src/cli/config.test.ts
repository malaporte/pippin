import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readGlobalConfig, writeGlobalConfig, expandHome } from './config'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

describe('expandHome', () => {
  it('expands ~ to the home directory', () => {
    const result = expandHome('~/Developer')
    expect(result).toBe(`${os.homedir()}/Developer`)
  })

  it('expands standalone ~', () => {
    const result = expandHome('~')
    expect(result).toBe(os.homedir())
  })

  it('leaves absolute paths unchanged', () => {
    const result = expandHome('/usr/local/bin')
    expect(result).toBe('/usr/local/bin')
  })

  it('leaves relative paths unchanged', () => {
    const result = expandHome('relative/path')
    expect(result).toBe('relative/path')
  })
})

describe('readGlobalConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = readGlobalConfig()
    expect(config.idleTimeout).toBe(900)
    expect(config.portRangeStart).toBe(9111)
    expect(config.dotfiles).toEqual([])
  })
})

describe('writeGlobalConfig + readGlobalConfig round-trip', () => {
  let tmpDir: string
  let origHome: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-cfg-')))
    // Override HOME so config reads/writes land in the temp dir
    origHome = os.homedir()
    vi.stubEnv('HOME', tmpDir)
    // Also patch os.homedir so config.ts picks up the new value
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads back a written config', async () => {
    const v = Date.now()
    const { writeGlobalConfig, readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    writeGlobalConfig({ idleTimeout: 600, portRangeStart: 10000, dotfiles: [{ path: '~/.zshrc' }], environment: ['GITHUB_TOKEN', 'NPM_TOKEN'] })

    const cfgPath = path.join(tmpDir, '.config', 'pippin', 'config.json')
    expect(fs.existsSync(cfgPath)).toBe(true)

    const cfg = readGlobalConfig()
    expect(cfg.idleTimeout).toBe(600)
    expect(cfg.portRangeStart).toBe(10000)
    expect(cfg.dotfiles).toHaveLength(1)
    expect(cfg.dotfiles[0].path).toBe('~/.zshrc')
    expect(cfg.environment).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN'])
  })

  it('uses defaults for invalid numeric values', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ idleTimeout: -1, portRangeStart: 0 }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.idleTimeout).toBe(900)
    expect(cfg.portRangeStart).toBe(9111)
  })

  it('filters out invalid dotfile entries', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        dotfiles: [
          { path: '~/.zshrc' },
          { notAPath: 'bad' },
          null,
          42,
          { path: '' },
        ],
      }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.dotfiles).toHaveLength(1)
    expect(cfg.dotfiles[0].path).toBe('~/.zshrc')
  })

  it('returns defaults when config file is malformed JSON', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), 'not json {{')

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.idleTimeout).toBe(900)
    expect(cfg.portRangeStart).toBe(9111)
    expect(cfg.dotfiles).toEqual([])
  })

  it('defaults environment to empty array when not present', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ idleTimeout: 300 }))

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.environment).toEqual([])
  })

  it('filters out invalid environment entries', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        environment: ['GITHUB_TOKEN', '', 42, null, 'NPM_TOKEN'],
      }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.environment).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN'])
  })
})
