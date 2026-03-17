import { execCommand } from './commands/exec'
import { initCommand } from './commands/init'
import { statusCommand } from './commands/status'
import { stopCommand } from './commands/stop'

// --- Parse Arguments ---

const args = process.argv.slice(2)

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

  case '--help':
  case '-h': {
    printUsage()
    break
  }

  case '--version':
  case '-v': {
    process.stdout.write('pippin 0.1.0\n')
    break
  }

  default: {
    process.stderr.write(`pippin: unknown command '${firstArg}'\n`)
    printUsage()
    process.exit(1)
  }
}

function printUsage(): void {
  process.stderr.write(
    `usage: pippin run <command>       run a command in the sandbox
       pippin init                create .pippin.toml in the current directory
       pippin status [--all]      show sandbox status
       pippin stop [--all]        stop sandbox(es)
       pippin --help              show this help
       pippin --version           show version
`,
  )
}
