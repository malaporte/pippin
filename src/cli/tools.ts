import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { expandHome } from './config'
import type { DotfileEntry } from '../shared/types'

// --- Tool Recipe Definitions ---

/**
 * Result returned by a recipe's hostPrepare function.
 * Allows recipes to inject env vars and override dotfile mounts
 * with dynamically generated files.
 */
export interface HostPrepareResult {
  /** Additional environment variables to forward into the container */
  env?: Record<string, string>
  /**
   * Dotfile mount overrides. Each key is the original `~/.foo/bar` path
   * from the recipe's `dotfiles` array. The value is the host-side path
   * to a generated file that should be mounted in its place.
   * This lets a recipe transform a config file (e.g. adding settings
   * needed for non-interactive auth) without modifying the user's original.
   */
  dotfileOverrides?: Record<string, string>
  /**
   * Additional volume mounts to add to the sandbox container.
   * Used for paths that are discovered dynamically at sandbox start time
   * (e.g. the pnpm content-addressable store, whose location varies by
   * platform and user configuration).
   */
  extraMounts?: Array<{ path: string; containerPath?: string; readonly?: boolean }>
}

export interface ToolRecipe {
  /** Human-readable display name */
  name: string
  /** Dotfiles / directories to mount into the container */
  dotfiles?: DotfileEntry[]
  /** Environment variables to forward from the host */
  environment?: string[]
  /**
   * Environment variables resolved dynamically at sandbox start time.
   * Each entry maps an env var name to a shell command that produces its value.
   * The command is only run if the env var is not already set in the host environment.
   */
  envResolvers?: Record<string, string>
  /**
   * A shell command that outputs multiple KEY=VALUE lines to stdout.
   * Used when a single command can resolve several env vars at once
   * (e.g. `aws configure export-credentials --format env-no-export`).
   * Only runs if at least one of the expected env vars is missing.
   */
  envMultiResolver?: string
  /** Whether this tool needs SSH agent forwarding */
  sshAgent?: boolean
  /** Whether this tool needs GPG agent forwarding (for commit signing) */
  gpgAgent?: boolean
  /**
   * A host-side prepare function that runs at sandbox start time.
   * Used for tools that need complex credential extraction (e.g. reading
   * tokens from the macOS keychain and generating modified config files).
   *
   * Receives the current shell environment and returns additional env vars
   * and/or dotfile mount overrides.
   */
  hostPrepare?: (shellEnv: Record<string, string>) => HostPrepareResult | undefined
}

/**
 * Built-in tool recipes. Each recipe describes what a tool needs to function
 * inside the sandbox: credential files to mount, env vars to forward, and
 * whether SSH agent access is required.
 *
 * All dotfiles are mounted read-only by default — the sandbox should never
 * modify host credentials.
 */

// --- Snowflake host-side preparation ---

/**
 * Parse a TOML file into a flat key-value structure sufficient for reading
 * Snowflake's config.toml. Only handles the subset of TOML we need:
 * bare keys, dotted section headers, and string/boolean values.
 */
function parseSimpleToml(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  let section = ''

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // Section header: [connections.dev-us-east-1]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }

    // Key = value
    const kvMatch = line.match(/^(\S+)\s*=\s*(.+)$/)
    if (kvMatch) {
      const key = section ? `${section}.${kvMatch[1]}` : kvMatch[1]
      let value = kvMatch[2].trim()
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
  }

  return result
}

/**
 * Snowflake host-side preparation.
 *
 * The Snowflake CLI uses `externalbrowser` auth which caches an ID token
 * in the macOS keychain. Inside the container (Linux), the keychain is
 * inaccessible, so we:
 *
 * 1. Parse ~/.snowflake/config.toml to find the default connection's
 *    account and user.
 * 2. Read the cached ID token from the macOS keychain using `security`.
 * 3. Compute the hash key used by the Snowflake Python connector's
 *    FileTokenCache (SHA-256 of "USER:HOST:ID_TOKEN").
 * 4. Return env vars (SNOWFLAKE_ID_TOKEN, SNOWFLAKE_TOKEN_HASH_KEY) that
 *    the container entrypoint uses to create the credential cache file.
 * 5. Generate a modified config.toml with `client_store_temporary_credential = true`
 *    appended to each connection, so the connector reads the file cache.
 */
function prepareSnowflake(shellEnv: Record<string, string>): HostPrepareResult | undefined {
  const configPath = expandHome('~/.snowflake/config.toml')
  if (!fs.existsSync(configPath)) return undefined

  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return undefined
  }

  const config = parseSimpleToml(content)

  // Find the default connection
  const connName = shellEnv['SNOWFLAKE_DEFAULT_CONNECTION_NAME']
    ?? config['default_connection_name']
    ?? 'default'

  const prefix = `connections.${connName}`
  const account = config[`${prefix}.account`]
  const user = config[`${prefix}.user`]
  const authenticator = config[`${prefix}.authenticator`]

  // Only extract keychain token for externalbrowser auth
  if (!account || !user || authenticator?.toLowerCase() !== 'externalbrowser') {
    return undefined
  }

  // Build the Snowflake host (add .snowflakecomputing.com if needed)
  const host = account.toLowerCase().includes('.snowflakecomputing.com')
    ? account.toUpperCase()
    : `${account.toUpperCase()}.SNOWFLAKECOMPUTING.COM`
  const upperUser = user.toUpperCase()

  // The keychain stores the token with service = string_key() = "USER:HOST:ID_TOKEN"
  // (the TokenKey dataclass fields are named (user, host) but _auth.py passes
  // (host, user) positionally, so self.host=user, self.user=host — the naming
  // is misleading but the format is USER:HOST:ID_TOKEN for both keyring and file cache)
  const keychainService = `${upperUser}:${host}:ID_TOKEN`
  // The keychain "account" (username) field stores the host value (due to the
  // same arg swap in the connector: key.user is actually the host).
  const keychainAccount = host

  // Read the cached ID token from the macOS keychain. We use the Python
  // `keyring` module from snow's own environment because the macOS keychain
  // ACL only grants access to the application that stored the item. The
  // `security` CLI triggers an authorization dialog that hangs in a non-
  // interactive context, but Python's keyring (which shares the same
  // entitlement as the snow process that wrote the token) reads it cleanly.
  const token = readKeychainViaSnowPython(shellEnv, keychainService, keychainAccount)
  if (!token) return undefined

  // Compute the hash key for the FileTokenCache.
  // The connector calls TokenKey(host, user, cred_type), but the TokenKey
  // dataclass fields are (user, host, tokenType) — so positional args swap:
  //   self.user = host, self.host = user
  // string_key() returns f"{self.host}:{self.user}:{type}" = "USER:HOST:ID_TOKEN"
  const stringKey = `${upperUser}:${host}:ID_TOKEN`
  const hashKey = crypto.createHash('sha256').update(stringKey).digest('hex')

  // Generate a modified config.toml that adds client_store_temporary_credential = true
  // to each connection section. This is required on Linux for the connector to
  // read from the file-based credential cache.
  const modifiedConfig = injectCredentialCacheSetting(content)
  const tmpDir = path.join(os.tmpdir(), 'pippin-snowflake')
  fs.mkdirSync(tmpDir, { recursive: true })
  const modifiedConfigPath = path.join(tmpDir, 'config.toml')
  fs.writeFileSync(modifiedConfigPath, modifiedConfig, { mode: 0o600 })

  return {
    env: {
      SNOWFLAKE_ID_TOKEN: token,
      SNOWFLAKE_TOKEN_HASH_KEY: hashKey,
    },
    dotfileOverrides: {
      '~/.snowflake/config.toml': modifiedConfigPath,
    },
  }
}

/**
 * Read a keychain password using Python's `keyring` module from the same
 * Python environment that the `snow` CLI uses. This avoids the macOS keychain
 * ACL issue where `security find-generic-password -w` triggers an authorization
 * dialog (and hangs in non-interactive contexts).
 *
 * We find snow's Python by reading the shebang of the `snow` binary. This
 * Python has `keyring` installed and shares the app identity that originally
 * stored the credential, so macOS grants access without prompting.
 */
function readKeychainViaSnowPython(
  shellEnv: Record<string, string>,
  service: string,
  account: string,
): string | undefined {
  // Find the `snow` binary in the user's PATH
  const snowWhich = spawnSync('sh', ['-l', '-c', 'which snow'], {
    encoding: 'utf-8',
    timeout: 5_000,
    env: shellEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const snowPath = snowWhich.stdout?.trim()
  if (!snowPath || snowWhich.status !== 0) return undefined

  // Read the shebang to find snow's Python interpreter
  let shebang: string
  try {
    const fd = fs.openSync(snowPath, 'r')
    const buf = Buffer.alloc(256)
    fs.readSync(fd, buf, 0, 256, 0)
    fs.closeSync(fd)
    const firstLine = buf.toString('utf-8').split('\n')[0]
    if (!firstLine.startsWith('#!')) return undefined
    shebang = firstLine.slice(2).trim()
  } catch {
    return undefined
  }

  // Resolve symlinks — if snow is a symlink (e.g. homebrew), the shebang
  // points into the Cellar. Follow the real path for the Python binary.
  const pythonPath = fs.existsSync(shebang) ? shebang : undefined
  if (!pythonPath) return undefined

  // Use keyring.get_password() to read the token
  const result = spawnSync(pythonPath, [
    '-c',
    `import keyring; t = keyring.get_password(${JSON.stringify(service)}, ${JSON.stringify(account)}); print(t or '', end='')`,
  ], {
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  const token = result.stdout?.trim()
  return token || undefined
}

/**
 * Inject `client_store_temporary_credential = true` into each [connections.*]
 * section of a Snowflake config.toml file content. If the setting already
 * exists in a section, it is left as-is.
 */
function injectCredentialCacheSetting(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let inConnectionSection = false
  let sectionHasSetting = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Detect start of a new section
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      // Before moving to a new section, inject the setting if the previous
      // connection section didn't have it
      if (inConnectionSection && !sectionHasSetting) {
        result.push('client_store_temporary_credential = true')
      }

      const sectionName = sectionMatch[1]
      inConnectionSection = sectionName.startsWith('connections.') && sectionName !== 'connections'
      sectionHasSetting = false
    }

    // Check if this line already sets the credential cache flag
    if (inConnectionSection && trimmed.startsWith('client_store_temporary_credential')) {
      sectionHasSetting = true
    }

    result.push(line)
  }

  // Handle the last section
  if (inConnectionSection && !sectionHasSetting) {
    result.push('client_store_temporary_credential = true')
  }

  return result.join('\n')
}

// --- SSH host-side preparation ---

/** Well-known default identity file basenames that OpenSSH tries automatically. */
const DEFAULT_KEY_BASENAMES = [
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
]

/**
 * Collect candidate SSH identity file paths from ~/.ssh/config IdentityFile
 * directives and the well-known default key basenames.
 *
 * Returns deduplicated, expanded absolute paths (~ resolved).
 * Does NOT check whether the files exist on disk — the caller should filter.
 */
export function discoverIdentityFiles(): string[] {
  const candidates = new Set<string>()

  // 1. Parse ~/.ssh/config for IdentityFile directives
  const configPath = expandHome('~/.ssh/config')
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*IdentityFile\s+(.+)/i)
      if (match) {
        const raw = match[1].trim()
        // Expand ~ and resolve to an absolute path
        const expanded = raw.startsWith('~') ? expandHome(raw) : path.resolve(raw)
        candidates.add(expanded)
      }
    }
  } catch {
    // No config or unreadable — continue with defaults only
  }

  // 2. Add well-known default key paths
  const sshDir = expandHome('~/.ssh')
  for (const basename of DEFAULT_KEY_BASENAMES) {
    candidates.add(path.join(sshDir, basename))
  }

  return Array.from(candidates)
}

/**
 * Ensure the macOS SSH agent has at least one key loaded.
 *
 * Docker Desktop for Mac forwards the host's launchd SSH agent into containers
 * via /run/host-services/ssh-auth.sock.  If the user's keys are passphrase-less
 * (or passphrase-protected but stored in the macOS Keychain), SSH on the host
 * works by reading key files directly — without the agent ever holding the key.
 * Inside the container, key files are intentionally not mounted (security), so
 * only the agent path works.
 *
 * This function bridges that gap: it discovers identity files that exist on the
 * host, checks whether the agent already has keys, and runs `ssh-add` for any
 * missing ones so that the forwarded agent inside the container can serve them.
 *
 * Only runs on macOS.  Failures are non-fatal — logged to stderr and skipped.
 */
export function ensureAgentHasKeys(): void {
  if (os.platform() !== 'darwin') return

  // Discover candidate key files and filter to those that exist on disk.
  // Only consider the private key file (not the .pub companion).
  const existing = discoverIdentityFiles().filter(p => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })

  if (existing.length === 0) return

  // Ask the agent what it already holds — parse fingerprints from `ssh-add -l`.
  // Output lines look like: "256 SHA256:abc123... user@host (ED25519)"
  const listResult = spawnSync('ssh-add', ['-l'], {
    encoding: 'utf-8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Collect fingerprints of keys the agent already has
  const loadedFingerprints = new Set<string>()
  if (listResult.status === 0 && listResult.stdout) {
    for (const line of listResult.stdout.trim().split('\n')) {
      // Extract the SHA256:... fingerprint (second field)
      const parts = line.split(/\s+/)
      if (parts.length >= 2 && parts[1].startsWith('SHA256:')) {
        loadedFingerprints.add(parts[1])
      }
    }
  }

  // For each candidate key, compute its fingerprint and add it if missing
  for (const keyPath of existing) {
    try {
      // Get fingerprint of this key file
      const fpResult = spawnSync('ssh-keygen', ['-l', '-f', keyPath], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (fpResult.status !== 0) continue

      const fpParts = (fpResult.stdout || '').trim().split(/\s+/)
      const fingerprint = fpParts.length >= 2 ? fpParts[1] : ''
      if (fingerprint && loadedFingerprints.has(fingerprint)) continue

      // Key exists on disk but is not in the agent — add it.
      // On macOS, --apple-use-keychain retrieves the passphrase from the
      // Keychain if it was stored there (common when UseKeychain is enabled).
      // For passphrase-less keys it is harmless.
      const addResult = spawnSync('ssh-add', ['--apple-use-keychain', keyPath], {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      if (addResult.status === 0) {
        process.stderr.write(`pippin: added ${keyPath} to SSH agent\n`)
        // Record the fingerprint so we don't try to add it again
        if (fingerprint) loadedFingerprints.add(fingerprint)
      }
      // If ssh-add fails (e.g. passphrase not in Keychain and no TTY), skip silently
    } catch {
      // Individual key failure — continue with the rest
    }
  }
}

/**
 * Sanitize ~/.ssh/config for use inside a Linux container.
 *
 * macOS-specific options like `UseKeychain` and `AddKeysToAgent` cause
 * OpenSSH on Linux to abort with "Bad configuration option". We prepend
 * `IgnoreUnknown` so they are silently skipped, and rewrite host-specific
 * identity file paths from the macOS home directory to /root.
 */
function prepareSSH(_shellEnv: Record<string, string>): HostPrepareResult | undefined {
  const configPath = expandHome('~/.ssh/config')
  if (!fs.existsSync(configPath)) return undefined

  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return undefined
  }

  // Detect macOS-specific options that need IgnoreUnknown
  const macOSOptions = ['UseKeychain', 'AddKeysToAgent']
  const found = macOSOptions.filter(opt =>
    content.match(new RegExp(`^\\s*${opt}\\b`, 'mi'))
  )

  if (found.length === 0) return undefined

  // Prepend IgnoreUnknown directive
  const sanitized = `# Added by pippin: ignore macOS-specific SSH options on Linux\nIgnoreUnknown ${found.join(',')}\n\n${content}`

  const tmpDir = path.join(os.tmpdir(), 'pippin-ssh')
  fs.mkdirSync(tmpDir, { recursive: true })
  const sanitizedPath = path.join(tmpDir, 'config')
  fs.writeFileSync(sanitizedPath, sanitized, { mode: 0o600 })

  return {
    dotfileOverrides: {
      '~/.ssh/config': sanitizedPath,
    },
  }
}

// --- pnpm host-side preparation ---

/**
 * Detect the host's pnpm content-addressable store and mount it into the
 * sandbox so that `pnpm install` inside the container reuses cached packages
 * instead of re-downloading everything on each fresh sandbox start.
 *
 * The store location varies by platform and user configuration:
 *   macOS:  ~/Library/pnpm/store/v3
 *   Linux:  ~/.local/share/pnpm/store/v3
 *   custom: wherever $PNPM_HOME points, or the output of `pnpm store path`
 *
 * We run `pnpm store path` on the host to get the authoritative location,
 * then mount it read-write at the same absolute path inside the container.
 * pnpm records the store path inside node_modules metadata, so preserving the
 * exact path avoids triggering a full modules-directory rebuild.
 */
function preparePnpm(shellEnv: Record<string, string>): HostPrepareResult | undefined {
  const result = spawnSync('sh', ['-l', '-c', 'pnpm store path'], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: shellEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  const storePath = result.stdout?.trim()
  if (!storePath || result.status !== 0) return undefined

  // Expand ~ if pnpm returns a tilde-prefixed path
  const hostStorePath = storePath.startsWith('~') ? expandHome(storePath) : storePath

  if (!fs.existsSync(hostStorePath)) return undefined

  return {
    extraMounts: [{ path: hostStorePath, containerPath: hostStorePath, readonly: false }],
    env: {
      PNPM_STORE_DIR: hostStorePath,
      npm_config_store_dir: hostStorePath,
    },
  }
}

/**
 * Resolve the host's pnpm store path for use in config hash computation.
 * Returns the absolute path, or undefined if pnpm is not installed or the
 * store path cannot be determined.
 */
export function resolvePnpmStorePath(shellEnv: Record<string, string>): string | undefined {
  const result = spawnSync('sh', ['-l', '-c', 'pnpm store path'], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: shellEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  const storePath = result.stdout?.trim()
  if (!storePath || result.status !== 0) return undefined

  const hostStorePath = storePath.startsWith('~') ? expandHome(storePath) : storePath
  return fs.existsSync(hostStorePath) ? hostStorePath : undefined
}

// Exported for testing
export { parseSimpleToml as _parseSimpleToml, injectCredentialCacheSetting as _injectCredentialCacheSetting, prepareSSH as _prepareSSH, discoverIdentityFiles as _discoverIdentityFiles, ensureAgentHasKeys as _ensureAgentHasKeys, preparePnpm as _preparePnpm }

export const RECIPES: Record<string, ToolRecipe> = {
  git: {
    name: 'Git',
    dotfiles: [
      { path: '~/.gitconfig', readonly: true },
      { path: '~/.gitignore_global', readonly: true },
      { path: '~/.gnupg/pubring.gpg', readonly: true },
      { path: '~/.gnupg/pubring.kbx', readonly: true },
      { path: '~/.gnupg/trustdb.gpg', readonly: true },
    ],
    sshAgent: true,
    gpgAgent: true,
  },
  gh: {
    name: 'GitHub CLI',
    // Mount only config.yml (aliases, preferences) — NOT the whole directory.
    // hosts.yml contains a keychain-backed auth entry that doesn't work inside
    // containers and causes `gh` to ignore the GH_TOKEN env var.
    dotfiles: [
      { path: '~/.config/gh/config.yml', readonly: true },
    ],
    environment: ['GITHUB_TOKEN', 'GH_TOKEN'],
    envResolvers: {
      GH_TOKEN: 'gh auth token',
    },
  },
  aws: {
    name: 'AWS CLI',
    // Mount only config (region, profile, SSO session settings) — NOT the whole
    // directory.  The SSO credential provider needs to write cache files under
    // ~/.aws/sso/cache/ and ~/.aws/cli/cache/, which fails on a read-only mount.
    // Instead we resolve temporary credentials via envMultiResolver.
    dotfiles: [
      { path: '~/.aws/config', readonly: true },
    ],
    environment: ['AWS_PROFILE', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CREDENTIAL_EXPIRATION'],
    envMultiResolver: 'aws configure export-credentials --format env-no-export',
  },
  snowflake: {
    name: 'Snowflake',
    // Mount only config.toml — NOT the whole directory. The logs/ subdirectory
    // is writable state we don't need, and we may need to generate a modified
    // config with `client_store_temporary_credential = true` for cached-token
    // auth to work inside the container (see hostPrepare).
    dotfiles: [
      { path: '~/.snowflake/config.toml', readonly: true },
    ],
    environment: ['SNOWFLAKE_DEFAULT_CONNECTION_NAME'],
    // Internal env vars used by the container entrypoint to reconstruct the
    // Snowflake credential cache (see sandbox.ts bootstrap).
    hostPrepare: prepareSnowflake,
  },
  npm: {
    name: 'npm',
    dotfiles: [
      { path: '~/.npmrc', readonly: true },
    ],
    environment: ['NPM_TOKEN', 'NPM_CONFIG_REGISTRY'],
  },
  bun: {
    name: 'bun',
    dotfiles: [
      // Bun respects ~/.npmrc for registry and auth settings
      { path: '~/.npmrc', readonly: true },
    ],
    environment: ['NPM_TOKEN', 'NPM_CONFIG_REGISTRY', 'BUN_INSTALL'],
  },
  pnpm: {
    name: 'pnpm',
    dotfiles: [
      // pnpm respects ~/.npmrc for registry and auth settings
      { path: '~/.npmrc', readonly: true },
    ],
    environment: ['NPM_TOKEN', 'NPM_CONFIG_REGISTRY', 'PNPM_HOME'],
    hostPrepare: preparePnpm,
  },
  uv: {
    name: 'uv',
    dotfiles: [
      { path: '~/.config/uv/uv.toml', readonly: true },
    ],
    // Forward common uv env vars for registry auth and Python selection.
    // The uv cache (~/.cache/uv) is NOT mounted: it contains arch-specific
    // Python interpreter binaries and pre-built wheels that are incompatible
    // between the macOS host (arm64/x64) and the Linux container.
    environment: [
      'UV_INDEX_URL',
      'UV_EXTRA_INDEX_URL',
      'UV_DEFAULT_INDEX',
      'UV_PYTHON_PREFERENCE',
      'UV_PYTHON_DOWNLOADS',
      'UV_SYSTEM_PYTHON',
    ],
  },
  ssh: {
    name: 'SSH',
    dotfiles: [
      { path: '~/.ssh/config', readonly: true },
      { path: '~/.ssh/known_hosts', readonly: true },
    ],
    sshAgent: true,
    hostPrepare: (shellEnv) => {
      // Ensure the macOS SSH agent has keys loaded before we start the
      // container — Docker Desktop forwards this agent, so it must hold
      // the keys for SSH to work inside the sandbox.
      ensureAgentHasKeys()
      return prepareSSH(shellEnv)
    },
  },
  codex: {
    name: 'OpenAI Codex',
    // Mount the user-level config (model, provider, approval policy, sandbox settings)
    // and the cached auth token file. auth.json only exists when the user has configured
    // cli_auth_credentials_store = "file" or when the OS keychain is unavailable.
    // If it doesn't exist on the host, the mount is silently skipped.
    dotfiles: [
      { path: '~/.codex/config.toml', readonly: true },
      { path: '~/.codex/auth.json', readonly: true },
    ],
    // OPENAI_API_KEY is the standard API-key auth path. Users who authenticate via
    // `codex login` with file-based credential storage get auth.json mounted instead.
    environment: ['OPENAI_API_KEY'],
  },
  jira: {
    name: 'Jira CLI',
    dotfiles: [
      { path: '~/.config/.jira/.config.yml', readonly: true },
    ],
    environment: ['JIRA_API_TOKEN'],
  },
  copilot: {
    name: 'GitHub Copilot CLI',
    // Mount the Copilot CLI config (trusted folders, settings). On headless systems
    // this file may also contain a plaintext token fallback, but we prefer env vars.
    dotfiles: [
      { path: '~/.copilot/config.json', readonly: true },
    ],
    // Copilot CLI checks tokens in priority order: COPILOT_GITHUB_TOKEN > GH_TOKEN >
    // GITHUB_TOKEN > keychain > gh auth fallback. We forward all three env vars so
    // any existing host-side token is available inside the container.
    environment: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    // If COPILOT_GITHUB_TOKEN is not already set, resolve it from the GitHub CLI's
    // credential store. This mirrors the gh recipe's approach: extract the token on
    // the host (where the keychain is accessible) and inject it at the highest
    // priority level so Copilot CLI uses it without needing its own keychain access.
    envResolvers: {
      COPILOT_GITHUB_TOKEN: 'gh auth token',
    },
  },
}

/** All known tool names (for validation in doctor, init, etc.) */
export const KNOWN_TOOLS = Object.keys(RECIPES)

// --- Resolved Requirements ---

export interface ToolRequirements {
  /** Dotfiles to mount (deduplicated by expanded path) */
  dotfiles: DotfileEntry[]
  /** Environment variable names to forward (deduplicated) */
  environment: string[]
  /** Environment variables resolved dynamically via shell commands (name -> command) */
  envResolvers: Record<string, string>
  /** Shell commands that output multiple KEY=VALUE lines (deduplicated) */
  envMultiResolvers: string[]
  /** Whether any tool needs SSH agent forwarding */
  sshAgent: boolean
  /** Whether any tool needs GPG agent forwarding */
  gpgAgent: boolean
  /** Tool names that were requested but have no built-in recipe */
  warnings: string[]
  /** Host-side prepare functions to run at sandbox start */
  hostPrepares: Array<(shellEnv: Record<string, string>) => HostPrepareResult | undefined>
  /**
   * Extra volume mounts collected from hostPrepare results.
   * Populated after hostPrepares have been run (in sandbox.ts, not here).
   * Declared here so the type flows through cleanly.
   */
  extraMounts: Array<{ path: string; readonly?: boolean }>
}

/**
 * Resolve tool recipes for a list of tool names. Merges all recipe requirements
 * into a single set of dotfiles, env vars, and an sshAgent flag.
 *
 * Unknown tool names are collected into the `warnings` array but do not cause
 * a failure — this lets users add tools before pippin ships a recipe for them,
 * and gets a helpful warning from `pippin doctor`.
 */
export function resolveToolRequirements(tools: string[]): ToolRequirements {
  const dotfileMap = new Map<string, DotfileEntry>() // keyed by expanded path
  const envSet = new Set<string>()
  const envResolvers: Record<string, string> = {}
  const envMultiResolverSet = new Set<string>()
  let sshAgent = false
  let gpgAgent = false
  const warnings: string[] = []
  const hostPrepares: ToolRequirements['hostPrepares'] = []

  const seen = new Set<string>()

  for (const tool of tools) {
    const name = tool.toLowerCase()

    // Deduplicate tool names
    if (seen.has(name)) continue
    seen.add(name)

    const recipe = RECIPES[name]
    if (!recipe) {
      warnings.push(name)
      continue
    }

    // Merge dotfiles (first occurrence of a path wins)
    if (recipe.dotfiles) {
      for (const df of recipe.dotfiles) {
        const expanded = expandHome(df.path)
        if (!dotfileMap.has(expanded)) {
          dotfileMap.set(expanded, df)
        }
      }
    }

    // Merge environment variables
    if (recipe.environment) {
      for (const env of recipe.environment) {
        envSet.add(env)
      }
    }

    // Merge env resolvers (first resolver for a given env var wins)
    if (recipe.envResolvers) {
      for (const [envVar, command] of Object.entries(recipe.envResolvers)) {
        if (!(envVar in envResolvers)) {
          envResolvers[envVar] = command
        }
      }
    }

    // Collect multi-var resolvers (deduplicated by command string)
    if (recipe.envMultiResolver) {
      envMultiResolverSet.add(recipe.envMultiResolver)
    }

    // OR the sshAgent flag
    if (recipe.sshAgent) {
      sshAgent = true
    }

    // OR the gpgAgent flag
    if (recipe.gpgAgent) {
      gpgAgent = true
    }

    // Collect host-side prepare functions
    if (recipe.hostPrepare) {
      hostPrepares.push(recipe.hostPrepare)
    }
  }

  return {
    dotfiles: Array.from(dotfileMap.values()),
    environment: Array.from(envSet),
    envResolvers,
    envMultiResolvers: Array.from(envMultiResolverSet),
    sshAgent,
    gpgAgent,
    warnings,
    hostPrepares,
    extraMounts: [],
  }
}
