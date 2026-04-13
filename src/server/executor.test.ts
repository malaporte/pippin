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
// Pipe-mode tests (original behavior, tty=false or omitted)
// ---------------------------------------------------------------------------

describe('getActiveSessionCount', () => {
  it('returns 0 before any sessions are created', () => {
    // Module-level state; reset via destroyAllSessions
    destroyAllSessions()
    expect(getActiveSessionCount()).toBe(0)
  })
})

describe('createSession (pipe mode)', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('increments session count', () => {
    destroyAllSessions()
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'true' })
    expect(getActiveSessionCount()).toBe(1)
    destroySession(id)
  })

  it('returns a session ID string', () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'true' })
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^sess_/)
  })

  it('sends stdout data as base64 over the WebSocket', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'printf hello' })

    await waitFor(() => ws.sent.some((m) => m.includes('"stdout"')))

    const stdoutMsg = ws.sent.find((m) => m.includes('"stdout"'))!
    const parsed = JSON.parse(stdoutMsg)
    expect(parsed.type).toBe('stdout')
    expect(Buffer.from(parsed.data, 'base64').toString()).toContain('hello')
  })

  it('sends an exit message when the command finishes', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'true' }) // exits with code 0

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))

    const exitMsg = ws.sent.find((m) => m.includes('"exit"'))!
    const parsed = JSON.parse(exitMsg)
    expect(parsed.type).toBe('exit')
    expect(parsed.code).toBe(0)
  })

  it('sends exit code 1 for a failing command', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'exit 1' })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))

    const exitMsg = ws.sent.find((m) => m.includes('"exit"'))!
    expect(JSON.parse(exitMsg).code).toBe(1)
  })

  it('decrements session count after the process exits', async () => {
    destroyAllSessions()
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'true' })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))
    await waitFor(() => getActiveSessionCount() === 0)

    expect(getActiveSessionCount()).toBe(0)
  })

  it('sends stderr output', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'printf err >&2' })

    await waitFor(() => ws.sent.some((m) => m.includes('"stderr"')))

    const msg = ws.sent.find((m) => m.includes('"stderr"'))!
    const parsed = JSON.parse(msg)
    expect(parsed.type).toBe('stderr')
    expect(Buffer.from(parsed.data, 'base64').toString()).toContain('err')
  })
})

describe('handleMessage (pipe mode)', () => {
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
    const id = createSession(ws as never, { cmd: 'cat' })

    handleMessage(id, { type: 'stdin', data: Buffer.from('hello\n').toString('base64') })
    handleMessage(id, { type: 'close_stdin' })

    await waitFor(() => ws.sent.some((m) => m.includes('"stdout"')))

    const stdoutMsg = ws.sent.find((m) => m.includes('"stdout"'))!
    expect(Buffer.from(JSON.parse(stdoutMsg).data, 'base64').toString()).toContain('hello')
  })

  it('close_stdin ends the process stdin', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'cat' })

    handleMessage(id, { type: 'close_stdin' })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')))
    expect(JSON.parse(ws.sent.find((m) => m.includes('"exit"'))!).type).toBe('exit')
  })

  it('resize message is a no-op and does not throw', () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'sleep 60' })

    expect(() =>
      handleMessage(id, { type: 'resize', cols: 80, rows: 24 })
    ).not.toThrow()

    destroySession(id)
  })

  it('signal SIGTERM kills the process', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'sleep 60' })

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
    const id = createSession(ws as never, { cmd: 'sleep 60' })
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
    createSession(ws1 as never, { cmd: 'sleep 60' })
    createSession(ws2 as never, { cmd: 'sleep 60' })

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
    createSession(ws as never, { cmd: 'true' })

    // Should have received at least count=1
    expect(counts).toContain(1)
  })

  it('is called with 0 when the session ends', async () => {
    const counts: number[] = []
    setSessionCountListener((n) => counts.push(n))

    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'true' })

    await waitFor(() => counts.includes(0))
    expect(counts).toContain(0)
  })
})

// ---------------------------------------------------------------------------
// PTY-mode tests (tty: true)
// ---------------------------------------------------------------------------

describe('createSession (pty mode)', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('increments session count', () => {
    destroyAllSessions()
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'true', tty: true, cols: 80, rows: 24 })
    expect(getActiveSessionCount()).toBe(1)
    destroySession(id)
  })

  it('returns a session ID string', () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'true', tty: true })
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^sess_/)
    destroySession(id)
  })

  it('sends stdout data from PTY as base64 over the WebSocket', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'printf hello', tty: true, cols: 80, rows: 24 })

    await waitFor(() => ws.sent.some((m) => m.includes('"stdout"')))

    const stdoutMsgs = ws.sent.filter((m) => m.includes('"stdout"'))
    const combined = stdoutMsgs
      .map((m) => Buffer.from(JSON.parse(m).data, 'base64').toString())
      .join('')
    expect(combined).toContain('hello')
  })

  it('sends an exit message when the PTY process finishes', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'true', tty: true, cols: 80, rows: 24 })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')), 5000)

    const exitMsg = ws.sent.find((m) => m.includes('"exit"'))!
    const parsed = JSON.parse(exitMsg)
    expect(parsed.type).toBe('exit')
    expect(parsed.code).toBe(0)
  })

  it('decrements session count after the PTY process exits', async () => {
    destroyAllSessions()
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'true', tty: true, cols: 80, rows: 24 })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')), 5000)
    await waitFor(() => getActiveSessionCount() === 0)

    expect(getActiveSessionCount()).toBe(0)
  })

  it('does not send separate stderr messages (PTY merges streams)', async () => {
    const ws = makeMockWs()
    createSession(ws as never, { cmd: 'printf err >&2', tty: true, cols: 80, rows: 24 })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')), 5000)

    // In PTY mode, stderr is merged into stdout; no separate 'stderr' messages
    const stderrMsgs = ws.sent.filter((m) => m.includes('"stderr"'))
    expect(stderrMsgs.length).toBe(0)

    // The error output should appear in stdout instead
    const stdoutMsgs = ws.sent.filter((m) => m.includes('"stdout"'))
    const combined = stdoutMsgs
      .map((m) => Buffer.from(JSON.parse(m).data, 'base64').toString())
      .join('')
    expect(combined).toContain('err')
  })
})

describe('handleMessage (pty mode)', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('writes stdin data to the PTY', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'cat', tty: true, cols: 80, rows: 24 })

    // In PTY mode, cat echoes via the terminal driver
    handleMessage(id, { type: 'stdin', data: Buffer.from('hello').toString('base64') })

    await waitFor(() => {
      const stdoutMsgs = ws.sent.filter((m) => m.includes('"stdout"'))
      const combined = stdoutMsgs
        .map((m) => Buffer.from(JSON.parse(m).data, 'base64').toString())
        .join('')
      return combined.includes('hello')
    })

    destroySession(id)
  })

  it('resize actually resizes the PTY (does not throw)', () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'sleep 60', tty: true, cols: 80, rows: 24 })

    // Should not throw -- and unlike pipe mode, this actually resizes
    expect(() =>
      handleMessage(id, { type: 'resize', cols: 120, rows: 40 })
    ).not.toThrow()

    destroySession(id)
  })

  it('close_stdin is a no-op and does not exit the PTY process', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'sleep 2', tty: true, cols: 80, rows: 24 })

    // Sending close_stdin should NOT cause the process to exit
    handleMessage(id, { type: 'close_stdin' })

    // Wait a bit and confirm no exit message was sent
    await new Promise((r) => setTimeout(r, 200))
    expect(ws.sent.some((m) => m.includes('"exit"'))).toBe(false)

    destroySession(id)
  })

  it('signal SIGTERM kills the PTY process', async () => {
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'sleep 60', tty: true, cols: 80, rows: 24 })

    handleMessage(id, { type: 'signal', signal: 'SIGTERM' })

    await waitFor(() => ws.sent.some((m) => m.includes('"exit"')), 10_000)
    expect(ws.sent.some((m) => m.includes('"exit"'))).toBe(true)
  }, 15_000)
})

describe('destroySession (pty mode)', () => {
  afterEach(() => {
    destroyAllSessions()
  })

  it('decrements the session count for PTY sessions', () => {
    destroyAllSessions()
    const ws = makeMockWs()
    const id = createSession(ws as never, { cmd: 'sleep 60', tty: true, cols: 80, rows: 24 })
    expect(getActiveSessionCount()).toBe(1)

    destroySession(id)
    expect(getActiveSessionCount()).toBe(0)
  })
})
