import { execCommand } from './commands/exec'
import { initCommand } from './commands/init'
import { monitorCommand } from './commands/monitor'
import { statusCommand } from './commands/status'
import { stopCommand } from './commands/stop'
import { updateCommand } from './commands/update'
import { checkForUpdate } from './update-check'
import { VERSION } from './version'

// --- Parse Arguments ---

const args = process.argv.slice(2)

// Start the update check in the background immediately (non-blocking)
const updateCheckPromise = checkForUpdate().catch(() => null)

if (args.length === 0) {
  printUsage()
  process.exit(1)
}

const firstArg = args[0]

// --- Route to subcommands ---

switch (firstArg) {
  case 'run': {
    const cmd = args.slice(1).join(' ')

    if (!cmd) {
      process.stderr.write('usage: pippin run <command>\n')
      process.exit(1)
    }

    await execCommand(cmd)
    break
  }

  case 'init': {
    initCommand()
    break
  }

  case 'status': {
    const showAll = args.includes('--all')
    await statusCommand(showAll)
    break
  }

  case 'stop': {
    const all = args.includes('--all')
    await stopCommand(all)
    break
  }

  case 'monitor': {
    await monitorCommand()
    break
  }

  case 'update': {
    const force = args.includes('--force')
    await updateCommand(force)
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
    `usage: pippin run <command>       run a command in the sandbox
       pippin init                create .pippin.toml in the current directory
       pippin status [--all]      show sandbox status
       pippin stop [--all]        stop sandbox(es)
       pippin monitor             open the leash Control UI in your browser
       pippin update [--force]    update pippin to the latest version
       pippin --help              show this help
       pippin --version           show version
`,
  )
}
