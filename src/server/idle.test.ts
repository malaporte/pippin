import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIdleTimer } from './idle'

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
})
