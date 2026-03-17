import { DEFAULT_IDLE_TIMEOUT } from '../shared/types'

/** Manages an idle timer that triggers server shutdown when no sessions are active */
export interface IdleTimer {
  /** Notify the timer that the session count changed */
  update: (activeSessionCount: number) => void
  /** Cancel the timer entirely */
  cancel: () => void
}

/**
 * Create an idle timer that calls `onIdle` after `timeoutSeconds` of zero
 * active sessions. The timer resets whenever the session count rises above
 * zero and restarts when it drops back to zero.
 */
export function createIdleTimer(
  timeoutSeconds: number,
  onIdle: () => void,
): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function update(activeSessionCount: number): void {
    if (activeSessionCount > 0) {
      clear()
      return
    }

    // No active sessions — start the countdown if not already running
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        onIdle()
      }, timeoutSeconds * 1000)
    }
  }

  function cancel(): void {
    clear()
  }

  return { update, cancel }
}

/** Read the idle timeout from the PIPPIN_IDLE_TIMEOUT env var, falling back to the default */
export function readIdleTimeout(): number {
  const envVal = process.env.PIPPIN_IDLE_TIMEOUT
  if (envVal) {
    const parsed = parseInt(envVal, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_IDLE_TIMEOUT
}
