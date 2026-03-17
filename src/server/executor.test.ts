import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSession,
  handleMessage,
  destroySession,
  destroyAllSessions,
  getActiveSessionCount,
  setSessionCountListener,
} from './executor'

// ---------------------------------------------------------------------------
// Minimal mock for Bun's ServerWebSocket
// ---------------------------------------------------------------------------

function makeMockWs() {
  const sent: string[] = []
  let closed = false
  return {
    send: vi.fn((msg: string) => { sent.push(msg) }),
    close: vi.fn(() => { closed = true }),
    data: { sessionId: '' },
    get sent() { return sent },
    get closed() { return closed },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait up to `ms` for `predicate` to return true, polling every 10 ms. */
async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getActiveSessionCount', () => {
  it('returns 0 before any sessions are created', () => {
    // Module-level state; reset via destroyAllSessions
    destroyAllSessions()
    expect(getActiveSessionCount()).toBe(0)
  })
})

describe('createSession', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('increments session count', () => {
    destroyAllSessions()
    const ws = makeMockWs()
    const id = createSession(ws as never, 'true')
    expect(getActiveSessionCount()).toBe(1)
    destroySession(id)
  })

  it('returns a session ID string', () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, 'true')
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^sess_/)
  })

  it('sends stdout data as base64 over the WebSocket', async () => {
    const ws = makeMockWs()
    createSession(ws as never, 'printf hello')

    await waitFor(() => ws.sent.some((m) => m.includes('"stdout"')))

    const stdoutMsg = ws.sent.find((m) => m.includes('"stdout"'))!
    const parsed = JSON.parse(stdoutMsg)
    expect(parsed.type).toBe('stdout')
    expect(Buffer.from(parsed.data, 'base64').toString()).toContain('hello')
  })

  it('sends an exit message when the command finishes', async () => {
    const ws = makeMockWs()
    createSession(ws as never, 'true') // exits with code 0

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))

    const exitMsg = ws.sent.find((m) => m.includes('"exit"'))!
    const parsed = JSON.parse(exitMsg)
    expect(parsed.type).toBe('exit')
    expect(parsed.code).toBe(0)
  })

  it('sends exit code 1 for a failing command', async () => {
    const ws = makeMockWs()
    createSession(ws as never, 'exit 1')

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))

    const exitMsg = ws.sent.find((m) => m.includes('"exit"'))!
    expect(JSON.parse(exitMsg).code).toBe(1)
  })

  it('decrements session count after the process exits', async () => {
    destroyAllSessions()
    const ws = makeMockWs()
    createSession(ws as never, 'true')

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))
    await waitFor(() => getActiveSessionCount() === 0)

    expect(getActiveSessionCount()).toBe(0)
  })

  it('sends stderr output', async () => {
    const ws = makeMockWs()
    createSession(ws as never, 'printf err >&2')

    await waitFor(() => ws.sent.some((m) => m.includes('"stderr"')))

    const msg = ws.sent.find((m) => m.includes('"stderr"'))!
    const parsed = JSON.parse(msg)
    expect(parsed.type).toBe('stderr')
    expect(Buffer.from(parsed.data, 'base64').toString()).toContain('err')
  })
})

describe('handleMessage', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('does nothing for an unknown session ID', () => {
    // Should not throw
    expect(() =>
      handleMessage('nonexistent', { type: 'stdin', data: Buffer.from('hi').toString('base64') })
    ).not.toThrow()
  })

  it('writes stdin data to the process', async () => {
    const ws = makeMockWs()
    // cat echoes stdin to stdout
    const id = createSession(ws as never, 'cat')

    handleMessage(id, { type: 'stdin', data: Buffer.from('hello\n').toString('base64') })
    handleMessage(id, { type: 'close_stdin' })

    await waitFor(() => ws.sent.some((m) => m.includes('"stdout"')))

    const stdoutMsg = ws.sent.find((m) => m.includes('"stdout"'))!
    expect(Buffer.from(JSON.parse(stdoutMsg).data, 'base64').toString()).toContain('hello')
  })

  it('close_stdin ends the process stdin', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, 'cat')

    handleMessage(id, { type: 'close_stdin' })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))
    expect(JSON.parse(ws.sent.find((m) => m.includes('"exit"'))!).type).toBe('exit')
  })

  it('resize message is a no-op and does not throw', () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, 'sleep 60')

    expect(() =>
      handleMessage(id, { type: 'resize', cols: 80, rows: 24 })
    ).not.toThrow()

    destroySession(id)
  })

  it('signal SIGTERM kills the process', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, 'sleep 60')

    handleMessage(id, { type: 'signal', signal: 'SIGTERM' })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')), 10_000)
    expect(ws.sent.some((m) => m.includes('"exit"'))).toBe(true)
  }, 15_000)
})

describe('destroySession', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('decrements the session count', () => {
    destroyAllSessions()
    const ws = makeMockWs()
    const id = createSession(ws as never, 'sleep 60')
    expect(getActiveSessionCount()).toBe(1)

    destroySession(id)
    expect(getActiveSessionCount()).toBe(0)
  })

  it('is a no-op for a non-existent session', () => {
    expect(() => destroySession('nope')).not.toThrow()
  })
})

describe('destroyAllSessions', () => {
  it('removes all active sessions', () => {
    const ws1 = makeMockWs()
    const ws2 = makeMockWs()
    createSession(ws1 as never, 'sleep 60')
    createSession(ws2 as never, 'sleep 60')

    destroyAllSessions()
    expect(getActiveSessionCount()).toBe(0)
  })
})

describe('setSessionCountListener', () => {
  afterEach(() => {
    destroyAllSessions()
    // Reset listener
    setSessionCountListener(() => {})
  })

  it('is called when a session is created', async () => {
    const counts: number[] = []
    setSessionCountListener((n) => counts.push(n))

    const ws = makeMockWs()
    createSession(ws as never, 'true')

    // Should have received at least count=1
    expect(counts).toContain(1)
  })

  it('is called with 0 when the session ends', async () => {
    const counts: number[] = []
    setSessionCountListener((n) => counts.push(n))

    const ws = makeMockWs()
    createSession(ws as never, 'true')

    await waitFor(() => counts.includes(0))
    expect(counts).toContain(0)
  })
})
