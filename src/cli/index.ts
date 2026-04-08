import { execCommand } from './commands/exec'
import { initCommand } from './commands/init'
import { monitorCommand } from './commands/monitor'
import { policyCommand } from './commands/policy'
import { shellCommand } from './commands/shell'
import { statusCommand } from './commands/status'
import { restartCommand } from './commands/restart'
import { stopCommand } from './commands/stop'
import { updateCommand } from './commands/update'
import { doctorCommand } from './commands/doctor'
import { checkForUpdate } from './update-check'
import { VERSION } from './version'

// --- Parse Arguments ---

const args = process.argv.slice(2)

function readSandboxFlag(argv: string[]): string | undefined {
  const index = argv.indexOf('--sandbox')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value) {
    process.stderr.write('pippin: --sandbox requires a name\n')
    process.exit(1)
  }
  return value
}

// Start the update check in the background immediately (non-blocking)
const updateCheckPromise = checkForUpdate().catch(() => null)

if (args.length === 0) {
  printUsage()
  process.exit(1)
}

const firstArg = args[0]
const sandboxName = readSandboxFlag(args)

// --- Route to subcommands ---

switch (firstArg) {
  case 'init': {
    initCommand()
    break
  }

  case 'shell': {
    await shellCommand(sandboxName)
    break
  }

  case 'status': {
    const showAll = args.includes('--all')
    await statusCommand(showAll, sandboxName)
    break
  }

  case 'stop': {
    const all = args.includes('--all')
    await stopCommand(all, sandboxName)
    break
  }

  case 'restart': {
    await restartCommand(sandboxName)
    break
  }

  case 'monitor': {
    await monitorCommand(sandboxName)
    break
  }

  case 'policy': {
    const validate = args.includes('--validate')
    policyCommand(validate, sandboxName)
    break
  }

  case 'update': {
    const force = args.includes('--force')
    await updateCommand(force)
    break
  }

  case 'doctor': {
    doctorCommand(sandboxName)
    break
  }

  case 'codex':
  case 'copilot': {
    const toolArgs = args.slice(1)
    const cmd = toolArgs.length > 0 ? `${firstArg} ${toolArgs.join(' ')}` : firstArg
    await execCommand(cmd, sandboxName)
    break
  }

  case '-c': {
    // POSIX shell interface: invoked as `pippin -c "<command>"` by Node's
    // child_process.spawn({ shell: "pippin" }) — e.g. from OpenCode's sandbox integration.
    const cmd = args[1]
    if (!cmd) {
      process.stderr.write('usage: pippin -c <command>\n')
      process.exit(1)
    }
    await execCommand(cmd, sandboxName)
    break
  }

  case '--help':
  case '-h': {
    printUsage()
    break
  }

  case '--version':
  case '-v': {
    process.stdout.write(`pippin ${VERSION}\n`)
    break
  }

  default: {
    process.stderr.write(`pippin: unknown command '${firstArg}'\n`)
    printUsage()
    process.exit(1)
  }
}

// Print any update notification after the command completes
const updateNotice = await updateCheckPromise
if (updateNotice) {
  process.stderr.write(updateNotice)
}

function printUsage(): void {
  process.stderr.write(
    `usage: pippin [--sandbox <name>] -c <command> run a command in the sandbox
       pippin init                configure a default sandbox if missing
       pippin [--sandbox <name>] shell open an interactive shell in the sandbox
       pippin codex [args]        run OpenAI Codex CLI in the sandbox
       pippin copilot [args]      run GitHub Copilot CLI in the sandbox
       pippin status [--all] [--sandbox <name>] show sandbox status
       pippin stop [--all] [--sandbox <name>] stop sandbox(es)
       pippin restart [--sandbox <name>] restart the sandbox (applies config changes)
       pippin monitor [--sandbox <name>] open the leash Control UI in your browser
       pippin policy [--validate] [--sandbox <name>] show or validate the active Cedar policy
       pippin update [--force]    update pippin to the latest version
       pippin doctor [--sandbox <name>] check prerequisites and validate configuration
       pippin --help              show this help
       pippin --version           show version
`,
  )
}
