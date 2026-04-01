import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { findWorkspaceConfig, resolveWorkspace, validateCwd } from './workspace'
import type { WorkspaceConfig } from '../shared/types'

describe('findWorkspaceConfig', () => {
  it('returns null when workspaces map is empty', () => {
    const result = findWorkspaceConfig('/foo/bar/baz', {})
    expect(result).toBeNull()
  })

  it('returns null when no key matches cwd', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      '^/other/path': { sandbox: { init: 'echo other' } },
    }
    const result = findWorkspaceConfig('/foo/bar', workspaces)
    expect(result).toBeNull()
  })

  it('matches a plain absolute path key (substring match)', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      '/foo/bar': { sandbox: { init: 'bun install' } },
    }
    const result = findWorkspaceConfig('/foo/bar', workspaces)
    expect(result).not.toBeNull()
    expect(result!.root).toBe('/foo/bar')
    expect(result!.config.sandbox?.init).toBe('bun install')
  })

  it('matches a plain path key against a subdirectory', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      '/foo/bar': { sandbox: { idle_timeout: 300 } },
    }
    const result = findWorkspaceConfig('/foo/bar/src/deep', workspaces)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.idle_timeout).toBe(300)
  })

  it('returns first matching key when multiple keys match', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      '^/foo': { sandbox: { init: 'first' } },
      '^/foo/bar': { sandbox: { init: 'second' } },
    }
    // first key wins regardless of specificity
    const result = findWorkspaceConfig('/foo/bar/baz', workspaces)
    expect(result).not.toBeNull()
    expect(result!.config.sandbox?.init).toBe('first')
  })

  it('matches a regex key with anchoring', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      '^/foo/bar(/|$)': { sandbox: { init: 'anchored' } },
    }
    expect(findWorkspaceConfig('/foo/bar/baz', workspaces)?.config.sandbox?.init).toBe('anchored')
    expect(findWorkspaceConfig('/foo/bar', workspaces)?.config.sandbox?.init).toBe('anchored')
    expect(findWorkspaceConfig('/foo/bar-extra', workspaces)).toBeNull()
  })

  it('matches a regex key with a capture group / alternation', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      '^/(foo|bar)/project': { sandbox: { init: 'multi' } },
    }
    expect(findWorkspaceConfig('/foo/project/src', workspaces)?.config.sandbox?.init).toBe('multi')
    expect(findWorkspaceConfig('/bar/project', workspaces)?.config.sandbox?.init).toBe('multi')
    expect(findWorkspaceConfig('/baz/project', workspaces)).toBeNull()
  })

  it('skips invalid regex keys with a warning and continues', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const workspaces: Record<string, WorkspaceConfig> = {
      '[invalid': { sandbox: { init: 'bad' } },
      '^/foo': { sandbox: { init: 'good' } },
    }
    const result = findWorkspaceConfig('/foo/bar', workspaces)
    expect(result?.config.sandbox?.init).toBe('good')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('invalid workspace key regex'))
    stderrSpy.mockRestore()
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

  it('returns the matched workspace when a key matches cwd', () => {
    const workspaces: Record<string, WorkspaceConfig> = {
      [tmpDir]: { sandbox: { idle_timeout: 600 } },
    }
    const result = resolveWorkspace(tmpDir, workspaces)
    expect(result.root).toBe(tmpDir)
    expect(result.config.sandbox?.idle_timeout).toBe(600)
  })

  it('returns implicit workspace rooted at cwd when no match and no .git exists', () => {
    const nested = path.join(tmpDir, 'no-config')
    fs.mkdirSync(nested, { recursive: true })

    const result = resolveWorkspace(nested, {})
    expect(result.root).toBe(nested)
    expect(result.config).toEqual({})
  })

  it('uses .git directory in ancestor as implicit workspace root', () => {
    const nested = path.join(tmpDir, 'project', 'src')
    fs.mkdirSync(nested, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'project', '.git'))

    const result = resolveWorkspace(nested, {})
    expect(result.root).toBe(path.join(tmpDir, 'project'))
    expect(result.config).toEqual({})
  })

  it('uses .git file in ancestor as implicit workspace root (worktree)', () => {
    const nested = path.join(tmpDir, 'worktree', 'src')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'worktree', '.git'), 'gitdir: ../.git/worktrees/my-branch\n')

    const result = resolveWorkspace(nested, {})
    expect(result.root).toBe(path.join(tmpDir, 'worktree'))
    expect(result.config).toEqual({})
  })

  it('workspaces map takes priority over .git when both match', () => {
    const nested = path.join(tmpDir, 'project', 'src')
    fs.mkdirSync(nested, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'project', '.git'))

    // workspace key points to a higher directory
    const workspaces: Record<string, WorkspaceConfig> = {
      [tmpDir]: { sandbox: { idle_timeout: 120 } },
    }
    const result = resolveWorkspace(nested, workspaces)
    expect(result.root).toBe(tmpDir)
    expect(result.config.sandbox?.idle_timeout).toBe(120)
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
