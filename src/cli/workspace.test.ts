import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { findWorkspace, resolveWorkspace, validateCwd } from './workspace'

describe('findWorkspace', () => {
  let tmpDir: string

  beforeEach(() => {
    // Resolve symlinks so macOS /var -> /private/var doesn't cause mismatches
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-test-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds .pippin.toml in the start directory', () => {
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), '[sandbox]\n')

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.root).toBe(fs.realpathSync(tmpDir))
  })

  it('finds .pippin.toml in a parent directory', () => {
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), '[sandbox]\nidle_timeout = 300\n')
    const nested = path.join(tmpDir, 'a', 'b', 'c')
    fs.mkdirSync(nested, { recursive: true })

    const result = findWorkspace(nested)
    expect(result).not.toBeNull()
    expect(result!.root).toBe(fs.realpathSync(tmpDir))
    expect(result!.config.sandbox?.idle_timeout).toBe(300)
  })

  it('returns null when no .pippin.toml exists', () => {
    const nested = path.join(tmpDir, 'empty')
    fs.mkdirSync(nested, { recursive: true })

    const result = findWorkspace(nested)
    expect(result).toBeNull()
  })

  it('parses extra mounts from .pippin.toml', () => {
    const toml = `
[sandbox]

[[sandbox.mounts]]
path = "~/Developer/libs"

[[sandbox.mounts]]
path = "~/Developer/other"
readonly = true
`
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), toml)

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.mounts).toHaveLength(2)
    expect(result!.config.sandbox?.mounts![0].path).toBe('~/Developer/libs')
    expect(result!.config.sandbox?.mounts![1].readonly).toBe(true)
  })

  it('handles empty .pippin.toml', () => {
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), '')

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config).toEqual({})
  })

  it('parses image from .pippin.toml', () => {
    const toml = `
[sandbox]
image = "my-registry/custom:latest"
`
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), toml)

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.image).toBe('my-registry/custom:latest')
    expect(result!.config.sandbox?.dockerfile).toBeUndefined()
  })

  it('parses dockerfile from .pippin.toml', () => {
    const toml = `
[sandbox]
dockerfile = "./Dockerfile.pippin"
`
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), toml)

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.dockerfile).toBe('./Dockerfile.pippin')
    expect(result!.config.sandbox?.image).toBeUndefined()
  })

  it('parses both image and dockerfile from .pippin.toml', () => {
    const toml = `
[sandbox]
image = "my-registry/custom:latest"
dockerfile = "./Dockerfile.pippin"
`
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), toml)

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.image).toBe('my-registry/custom:latest')
    expect(result!.config.sandbox?.dockerfile).toBe('./Dockerfile.pippin')
  })

  it('ignores invalid image values in .pippin.toml', () => {
    const toml = `
[sandbox]
image = 42
`
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), toml)

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.image).toBeUndefined()
  })

  it('ignores empty string image in .pippin.toml', () => {
    const toml = `
[sandbox]
image = ""
`
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), toml)

    const result = findWorkspace(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.image).toBeUndefined()
  })
})

describe('resolveWorkspace', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-test-')))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the found workspace when .pippin.toml exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.pippin.toml'), '[sandbox]\nidle_timeout = 600\n')

    const result = resolveWorkspace(tmpDir)
    expect(result.root).toBe(tmpDir)
    expect(result.config.sandbox?.idle_timeout).toBe(600)
  })

  it('returns implicit workspace rooted at cwd when no .pippin.toml exists', () => {
    const nested = path.join(tmpDir, 'no-config')
    fs.mkdirSync(nested, { recursive: true })

    const result = resolveWorkspace(nested)
    expect(result.root).toBe(nested)
    expect(result.config).toEqual({})
  })

  it('prints a notice to stderr for implicit workspace', () => {
    const nested = path.join(tmpDir, 'no-config')
    fs.mkdirSync(nested, { recursive: true })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      resolveWorkspace(nested)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('no .pippin.toml found'),
      )
    } finally {
      stderrSpy.mockRestore()
    }
  })
})

describe('validateCwd', () => {
  it('accepts CWD under the workspace root', () => {
    const result = validateCwd('/home/user/project/src', '/home/user/project', [])
    expect(result).toBe('/home/user/project/src')
  })

  it('accepts CWD exactly at the workspace root', () => {
    const result = validateCwd('/home/user/project', '/home/user/project', [])
    expect(result).toBe('/home/user/project')
  })

  it('accepts CWD under an extra mount', () => {
    const result = validateCwd('/home/user/libs/foo', '/home/user/project', [
      { path: '/home/user/libs' },
    ])
    expect(result).toBe('/home/user/libs/foo')
  })

  it('rejects CWD outside all mounts', () => {
    const result = validateCwd('/tmp/random', '/home/user/project', [])
    expect(result).toBeNull()
  })

  it('rejects CWD that is a prefix but not a parent', () => {
    const result = validateCwd('/home/user/project-extra', '/home/user/project', [])
    expect(result).toBeNull()
  })
})
