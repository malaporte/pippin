import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readGlobalConfig, expandHome } from './config'
import os from 'node:os'

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
