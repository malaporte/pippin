import kleur from 'kleur'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const INTERVAL_MS = 80

/** A minimal stderr spinner for long-running operations */
export class Spinner {
  private message: string
  private frameIndex = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(message: string) {
    this.message = message
  }

  start(): void {
    if (this.timer) return
    // Only show spinner if stderr is a TTY
    if (!process.stderr.isTTY) return

    this.render()
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length
      this.render()
    }, INTERVAL_MS)
  }

  update(message: string): void {
    this.message = message
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    // Clear the spinner line
    process.stderr.write('\r\x1b[K')
  }

  private render(): void {
    const frame = FRAMES[this.frameIndex]
    process.stderr.write(`\r\x1b[K${kleur.gray(`${frame} ${this.message}`)}`)
  }
}
