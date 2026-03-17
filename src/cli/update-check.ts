import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VERSION } from './version'

const GITHUB_REPO = 'malaporte/pippin'
const CACHE_FILE = path.join(os.homedir(), '.local', 'state', 'pippin', 'update-check.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 2000

interface UpdateCache {
  checkedAt: number
  latestVersion: string | null
}

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

function readCache(): UpdateCache | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8')
    return JSON.parse(raw) as UpdateCache
  } catch {
    return null
  }
}

function writeCache(data: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8')
  } catch {
    // Best-effort; ignore write errors
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { 'User-Agent': `pippin/${VERSION}` },
    })
    if (!res.ok) return null
    const data = (await res.json()) as GitHubRelease
    return data.tag_name?.replace(/^v/, '') ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Checks GitHub Releases for a newer version of pippin.
 * Results are cached for 24 hours in ~/.local/state/pippin/update-check.json.
 * Returns a notice string to print, or null if up to date / check failed.
 */
export async function checkForUpdate(): Promise<string | null> {
  const now = Date.now()
  let latestVersion: string | null = null

  const cache = readCache()
  if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
    // Use cached result
    latestVersion = cache.latestVersion
  } else {
    // Fetch fresh and cache
    latestVersion = await fetchLatestVersion()
    writeCache({ checkedAt: now, latestVersion })
  }

  if (latestVersion && isNewer(VERSION, latestVersion)) {
    return (
      `\nA new version of pippin is available: ${latestVersion} (current: ${VERSION})\n` +
      `Upgrade: pippin update\n`
    )
  }

  return null
}
