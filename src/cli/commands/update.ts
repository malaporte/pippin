import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Spinner } from '../spinner'
import { VERSION } from '../version'
import { listStates } from '../state'
import { stopAllSandboxes } from '../sandbox'
import { updateLeash } from '../leash'

const GITHUB_REPO = 'malaporte/pippin'

interface GitHubRelease {
  tag_name: string
}

/** Compare two semver strings. Returns true if `latest` is newer than `current`. */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [cMaj, cMin, cPatch] = parse(current)
  const [lMaj, lMin, lPatch] = parse(latest)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPatch > cPatch
}

function detectPlatform(): { os: string; arch: string } {
  const platform = os.platform()
  const arch = os.arch()

  let osName: string
  switch (platform) {
    case 'darwin':
      osName = 'darwin'
      break
    case 'linux':
      osName = 'linux'
      break
    default:
      throw new Error(`unsupported OS: ${platform}`)
  }

  let archName: string
  switch (arch) {
    case 'arm64':
      archName = 'arm64'
      break
    case 'x64':
      archName = 'x64'
      break
    default:
      throw new Error(`unsupported architecture: ${arch}`)
  }

  return { os: osName, arch: archName }
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { 'User-Agent': `pippin/${VERSION}` },
  })
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`)
  }
  const data = (await res.json()) as GitHubRelease
  const version = data.tag_name?.replace(/^v/, '')
  if (!version) {
    throw new Error('could not determine latest version from GitHub API')
  }
  return version
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': `pippin/${VERSION}` },
  })
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`)
  }
  const buffer = await res.arrayBuffer()
  fs.writeFileSync(dest, Buffer.from(buffer))
}

function extractTarball(tarball: string, destDir: string): void {
  const result = Bun.spawnSync(['tar', '-xzf', tarball, '-C', destDir])
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(`failed to extract ${tarball}: ${stderr}`)
  }
}

/** Self-update pippin to the latest (or specified) version */
export async function updateCommand(force: boolean): Promise<void> {
  const spinner = new Spinner('Checking for updates...')
  spinner.start()

  let latestVersion: string
  try {
    latestVersion = await fetchLatestVersion()
  } catch (err) {
    spinner.stop()
    process.stderr.write(`pippin: failed to check for updates: ${(err as Error).message}\n`)
    process.exit(1)
  }

  if (!force && !isNewer(VERSION, latestVersion)) {
    spinner.stop()
    process.stderr.write(`pippin: already up to date (${VERSION})\n`)
    return
  }

  spinner.update(`Updating pippin ${VERSION} → ${latestVersion}...`)

  const { os: osName, arch } = detectPlatform()

  // Determine install directory from the current binary location
  const currentBinary = process.execPath
  const installDir = path.dirname(currentBinary)

  const cliTarball = `pippin-${osName}-${arch}.tar.gz`
  const serverTarball = `pippin-server-linux-${arch}.tar.gz`
  const baseUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${latestVersion}`

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-update-'))

  try {
    // Download CLI and server tarballs in parallel
    spinner.update('Downloading...')
    await Promise.all([
      downloadToFile(`${baseUrl}/${cliTarball}`, path.join(tmpDir, cliTarball)),
      downloadToFile(`${baseUrl}/${serverTarball}`, path.join(tmpDir, serverTarball)),
    ])

    // Extract
    spinner.update('Installing...')
    extractTarball(path.join(tmpDir, cliTarball), tmpDir)
    extractTarball(path.join(tmpDir, serverTarball), tmpDir)

    // Replace binaries atomically (rename within same filesystem may fail across devices)
    const cliBinaryName = `pippin-${osName}-${arch}`
    const serverBinaryName = `pippin-server-linux-${arch}`

    installBinary(path.join(tmpDir, cliBinaryName), path.join(installDir, 'pippin'))
    installBinary(path.join(tmpDir, serverBinaryName), path.join(installDir, serverBinaryName))

    spinner.stop()
    process.stderr.write(`pippin: updated to ${latestVersion} (was ${VERSION})\n`)

    // Update leash to the latest version as well
    const leashSpinner = new Spinner('Updating leash...')
    leashSpinner.start()
    await updateLeash(leashSpinner)
    leashSpinner.stop()

    // Stop all running sandboxes so they restart with the new server binary
    const runningSandboxes = listStates()
    if (runningSandboxes.length > 0) {
      await stopAllSandboxes()
      process.stderr.write('pippin: stopped running sandboxes to apply update\n')
    }
  } catch (err) {
    spinner.stop()
    process.stderr.write(`pippin: update failed: ${(err as Error).message}\n`)
    process.exit(1)
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Install a binary to a destination path, preserving 755 permissions */
function installBinary(src: string, dest: string): void {
  // Try atomic rename first (fast, works on same filesystem)
  try {
    // Write to a temp file next to the destination, then rename over it
    const tmpDest = `${dest}.tmp`
    fs.copyFileSync(src, tmpDest)
    fs.chmodSync(tmpDest, 0o755)
    fs.renameSync(tmpDest, dest)
    return
  } catch {
    // Fall back to direct copy
  }

  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
}
