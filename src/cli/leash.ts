import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Spinner } from './spinner'
import { VERSION } from './version'

const LEASH_REPO = 'strongdm/leash'

interface GitHubRelease {
  tag_name: string
  assets: { name: string; browser_download_url: string }[]
}

/** Map pippin's os/arch names to leash's goreleaser naming convention */
function leashPlatform(): { os: string; arch: string } {
  const platform = os.platform()
  const arch = os.arch()

  let osName: string
  switch (platform) {
    case 'darwin': osName = 'darwin'; break
    case 'linux':  osName = 'linux';  break
    default: throw new Error(`unsupported OS for leash: ${platform}`)
  }

  let archName: string
  switch (arch) {
    case 'arm64': archName = 'arm64'; break
    case 'x64':   archName = 'amd64'; break
    default: throw new Error(`unsupported architecture for leash: ${arch}`)
  }

  return { os: osName, arch: archName }
}

/** Directory where pippin (and leash) binaries live */
function installDir(): string {
  return path.dirname(process.execPath)
}

/**
 * Find the leash binary. Checks:
 * 1. Alongside the pippin binary (our managed install location)
 * 2. On PATH
 *
 * Returns the absolute path, or null if not found.
 */
export function findLeash(): string | null {
  // Check alongside pippin binary first (our managed location)
  const managed = path.join(installDir(), 'leash')
  try {
    fs.accessSync(managed, fs.constants.X_OK)
    return managed
  } catch { /* not there */ }

  // Check PATH
  const which = spawnSync('which', ['leash'], { encoding: 'utf-8', timeout: 5_000 })
  const location = (which.stdout || '').trim()
  if (which.status === 0 && location) {
    return location
  }

  return null
}

/** Get the installed leash version, or null if leash isn't found / doesn't respond */
export function getLeashVersion(leashPath: string): string | null {
  try {
    const result = spawnSync(leashPath, ['--version'], { encoding: 'utf-8', timeout: 10_000 })
    if (result.status !== 0) return null
    // leash --version output varies; grab the first line and extract a version-like string
    const line = (result.stdout || '').trim().split('\n')[0]
    const match = line.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : line || null
  } catch {
    return null
  }
}

/** Fetch the latest leash release metadata from GitHub */
async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${LEASH_REPO}/releases/latest`, {
    headers: { 'User-Agent': `pippin/${VERSION}` },
  })
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`)
  }
  return (await res.json()) as GitHubRelease
}

/** Download a URL to a local file */
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

/** Extract a tarball to a directory */
function extractTarball(tarball: string, destDir: string): void {
  const result = Bun.spawnSync(['tar', '-xzf', tarball, '-C', destDir])
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(`failed to extract ${tarball}: ${stderr}`)
  }
}

/** Strip macOS quarantine attribute so the unsigned binary can execute */
function stripQuarantine(binaryPath: string): void {
  if (os.platform() !== 'darwin') return
  spawnSync('xattr', ['-d', 'com.apple.quarantine', binaryPath], { timeout: 5_000 })
}

/** Install a binary to a destination path with 755 permissions */
function installBinary(src: string, dest: string): void {
  try {
    const tmpDest = `${dest}.tmp`
    fs.copyFileSync(src, tmpDest)
    fs.chmodSync(tmpDest, 0o755)
    fs.renameSync(tmpDest, dest)
    return
  } catch { /* fall back to direct copy */ }

  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
}

/**
 * Download and install the latest leash binary.
 * Returns the version that was installed.
 */
export async function installLeash(spinner?: Spinner): Promise<{ version: string; path: string }> {
  const release = await fetchLatestRelease()
  const version = release.tag_name.replace(/^v/, '')
  const { os: osName, arch } = leashPlatform()

  // Find the matching asset: leash_{version}_{os}_{arch}.tar.gz
  const assetName = `leash_${version}_${osName}_${arch}.tar.gz`
  const asset = release.assets.find((a) => a.name === assetName)
  if (!asset) {
    throw new Error(`no leash release asset found for ${osName}/${arch} (expected ${assetName})`)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pippin-leash-'))

  try {
    if (spinner) spinner.update(`downloading leash v${version}...`)

    await downloadToFile(asset.browser_download_url, path.join(tmpDir, assetName))
    extractTarball(path.join(tmpDir, assetName), tmpDir)

    // The tarball contains a `leash` binary at the root
    const extractedBinary = path.join(tmpDir, 'leash')
    if (!fs.existsSync(extractedBinary)) {
      throw new Error(`leash binary not found in tarball (expected ${assetName} to contain 'leash')`)
    }

    const dest = path.join(installDir(), 'leash')
    if (spinner) spinner.update(`installing leash v${version}...`)
    installBinary(extractedBinary, dest)
    stripQuarantine(dest)

    return { version, path: dest }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Ensure leash is available. If not found, auto-install it.
 * Returns the absolute path to the leash binary.
 */
export async function ensureLeash(): Promise<string> {
  const existing = findLeash()
  if (existing) return existing

  const spinner = new Spinner('leash not found, installing...')
  spinner.start()

  try {
    const result = await installLeash(spinner)
    spinner.stop()
    process.stderr.write(`pippin: installed leash v${result.version} to ${result.path}\n`)
    return result.path
  } catch (err) {
    spinner.stop()
    process.stderr.write(`pippin: failed to install leash: ${(err as Error).message}\n`)
    process.stderr.write('pippin: install leash manually — see https://github.com/strongdm/leash\n')
    process.exit(1)
  }
}

/**
 * Update leash to the latest version. Used by `pippin update`.
 * If leash is not currently installed alongside pippin, installs it.
 */
export async function updateLeash(spinner: Spinner): Promise<void> {
  const managedPath = path.join(installDir(), 'leash')
  const currentVersion = fs.existsSync(managedPath) ? getLeashVersion(managedPath) : null

  spinner.update('checking for leash updates...')

  try {
    const result = await installLeash(spinner)

    if (currentVersion && currentVersion === result.version) {
      process.stderr.write(`pippin: leash already up to date (${result.version})\n`)
    } else if (currentVersion) {
      process.stderr.write(`pippin: updated leash ${currentVersion} → ${result.version}\n`)
    } else {
      process.stderr.write(`pippin: installed leash v${result.version}\n`)
    }
  } catch (err) {
    process.stderr.write(`pippin: failed to update leash: ${(err as Error).message}\n`)
    // Non-fatal — pippin update shouldn't fail just because leash update failed
  }
}
