import { describe, expect, it } from 'vitest'
import { resolveSandbox, validateCwd, DEFAULT_SANDBOX_NAME } from './sandbox-config'

describe('resolveSandbox', () => {
  it('defaults to the default sandbox', () => {
    expect(resolveSandbox(undefined, {
      default: { root: '/tmp/dev' },
    })).toEqual({
      name: DEFAULT_SANDBOX_NAME,
      config: { root: '/tmp/dev' },
    })
  })

  it('returns the named sandbox when configured', () => {
    expect(resolveSandbox('work', {
      default: { root: '/tmp/dev' },
      work: { root: '/tmp/work' },
    })?.config.root).toBe('/tmp/work')
  })

  it('returns null when sandbox is missing', () => {
    expect(resolveSandbox('missing', { default: { root: '/tmp/dev' } })).toBeNull()
  })
})

describe('validateCwd', () => {
  it('accepts cwd under sandbox root', () => {
    expect(validateCwd('/home/user/dev/project', { root: '/home/user/dev' })).toBe('/home/user/dev/project')
  })

  it('accepts cwd under an extra mount', () => {
    expect(validateCwd('/opt/shared/foo', { root: '/home/user/dev', mounts: [{ path: '/opt/shared' }] })).toBe('/opt/shared/foo')
  })

  it('rejects cwd outside sandbox mounts', () => {
    expect(validateCwd('/tmp/random', { root: '/home/user/dev' })).toBeNull()
  })
})
