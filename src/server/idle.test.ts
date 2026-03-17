import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createIdleTimer, readIdleTimeout } from './idle'

describe('createIdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('calls onIdle after timeout when session count drops to zero', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)

    timer.update(0)

    vi.advanceTimersByTime(9999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledOnce()

    timer.cancel()
  })

  it('does not call onIdle if sessions become active before timeout', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)

    timer.update(0)
    vi.advanceTimersByTime(5000)

    // Session opens
    timer.update(1)

    vi.advanceTimersByTime(10_000)
    expect(onIdle).not.toHaveBeenCalled()

    timer.cancel()
  })

  it('restarts timer when sessions drop back to zero', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)

    timer.update(0)
    vi.advanceTimersByTime(5000)

    // Session opens then closes
    timer.update(1)
    timer.update(0)

    // Timer should restart from zero — needs full 10s again
    vi.advanceTimersByTime(9999)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledOnce()

    timer.cancel()
  })

  it('does not double-fire if already at zero sessions', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)

    timer.update(0)
    timer.update(0) // redundant call
    timer.update(0)

    vi.advanceTimersByTime(10_000)
    expect(onIdle).toHaveBeenCalledOnce()

    timer.cancel()
  })

  it('cancel prevents onIdle from firing', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)

    timer.update(0)
    vi.advanceTimersByTime(5000)

    timer.cancel()

    vi.advanceTimersByTime(10_000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('does not start countdown when there are active sessions at creation', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)

    // Never call update(0) — simulate a session that was already present
    timer.update(3)
    vi.advanceTimersByTime(20_000)
    expect(onIdle).not.toHaveBeenCalled()

    timer.cancel()
  })

  it('cancel is idempotent (can be called multiple times)', () => {
    const onIdle = vi.fn()
    const timer = createIdleTimer(10, onIdle)
    timer.update(0)

    expect(() => {
      timer.cancel()
      timer.cancel()
    }).not.toThrow()

    vi.advanceTimersByTime(15_000)
    expect(onIdle).not.toHaveBeenCalled()
  })
})

describe('readIdleTimeout', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 900 when env var is not set', () => {
    vi.stubEnv('PIPPIN_IDLE_TIMEOUT', '')
    expect(readIdleTimeout()).toBe(900)
  })

  it('returns the parsed value from PIPPIN_IDLE_TIMEOUT', () => {
    vi.stubEnv('PIPPIN_IDLE_TIMEOUT', '300')
    expect(readIdleTimeout()).toBe(300)
  })

  it('returns 900 when PIPPIN_IDLE_TIMEOUT is not a number', () => {
    vi.stubEnv('PIPPIN_IDLE_TIMEOUT', 'abc')
    expect(readIdleTimeout()).toBe(900)
  })

  it('returns 900 when PIPPIN_IDLE_TIMEOUT is zero', () => {
    vi.stubEnv('PIPPIN_IDLE_TIMEOUT', '0')
    expect(readIdleTimeout()).toBe(900)
  })

  it('returns 900 when PIPPIN_IDLE_TIMEOUT is negative', () => {
    vi.stubEnv('PIPPIN_IDLE_TIMEOUT', '-100')
    expect(readIdleTimeout()).toBe(900)
  })
})
