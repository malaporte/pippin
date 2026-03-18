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
    expect(config.idleTimeout).toBe(900)
    expect(config.portRangeStart).toBe(9111)
    expect(config.dotfiles).toEqual([])
    expect(config.environment).toEqual([])
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

  it('reads back a written config with image', async () => {
    const v = Date.now()
    const { writeGlobalConfig, readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    writeGlobalConfig({ image: 'my-registry/custom:latest' })

    const cfg = readGlobalConfig()
    expect(cfg.image).toBe('my-registry/custom:latest')
    expect(cfg.dockerfile).toBeUndefined()
  })

  it('reads back a written config with dockerfile', async () => {
    const v = Date.now()
    const { writeGlobalConfig, readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    writeGlobalConfig({ dockerfile: '~/my-dockerfiles/Dockerfile.pippin' })

    const cfg = readGlobalConfig()
    expect(cfg.dockerfile).toBe('~/my-dockerfiles/Dockerfile.pippin')
    expect(cfg.image).toBeUndefined()
  })

  it('ignores invalid image values', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ image: 42 }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.image).toBeUndefined()
  })

  it('ignores empty string image', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ image: '' }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.image).toBeUndefined()
  })

  it('ignores invalid dockerfile values', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ dockerfile: true }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.dockerfile).toBeUndefined()
  })

  it('defaults image and dockerfile to undefined when not present', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ idleTimeout: 300 }))

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.image).toBeUndefined()
    expect(cfg.dockerfile).toBeUndefined()
  })

  it('reads back hostCommands from a written config', async () => {
    const v = Date.now()
    const { writeGlobalConfig, readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    writeGlobalConfig({ hostCommands: ['git', 'ssh'] })

    const cfg = readGlobalConfig()
    expect(cfg.hostCommands).toEqual(['git', 'ssh'])
  })

  it('defaults hostCommands to empty array when not present', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ idleTimeout: 300 }))

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.hostCommands).toEqual([])
  })

  it('filters out invalid hostCommands entries', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        hostCommands: ['git', 42, null, '', 'ssh'],
      }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.hostCommands).toEqual(['git', 'ssh'])
  })

  it('defaults hostCommands to empty array when value is not an array', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ hostCommands: 'git' }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.hostCommands).toEqual([])
  })

  it('reads back tools from a written config', async () => {
    const v = Date.now()
    const { writeGlobalConfig, readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    writeGlobalConfig({ tools: ['git', 'gh', 'aws'] })

    const cfg = readGlobalConfig()
    expect(cfg.tools).toEqual(['git', 'gh', 'aws'])
  })

  it('defaults tools to empty array when not present', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ idleTimeout: 300 }))

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.tools).toEqual([])
  })

  it('filters out invalid tools entries', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({
        tools: ['git', 42, null, '', 'aws'],
      }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.tools).toEqual(['git', 'aws'])
  })

  it('defaults tools to empty array when value is not an array', async () => {
    const cfgDir = path.join(tmpDir, '.config', 'pippin')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ tools: 'git' }),
    )

    const v = Date.now()
    const { readGlobalConfig } = await import(/* @vite-ignore */ `./config.ts?v=${v}`)
    const cfg = readGlobalConfig()
    expect(cfg.tools).toEqual([])
  })
})
