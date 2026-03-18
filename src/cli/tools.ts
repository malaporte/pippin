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
 *    FileTokenCache (SHA-256 of "HOST:USER:ID_TOKEN").
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

  // The keychain stores the token with service = "USER:HOST:ID_TOKEN"
  // (this is the format used by the externalbrowser authenticator, which
  // differs from the KeyringTokenCache format of "HOST:USER:ID_TOKEN")
  const keychainService = `${upperUser}:${host}:ID_TOKEN`

  // Read the token from macOS keychain
  const result = spawnSync('security', [
    'find-generic-password', '-s', keychainService, '-w',
  ], {
    encoding: 'utf-8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  if (result.status !== 0 || !result.stdout?.trim()) {
    return undefined
  }

  const token = result.stdout.trim()

  // Compute the hash key for the FileTokenCache
  // FileTokenCache uses TokenKey.string_key() = "HOST:USER:ID_TOKEN"
  const stringKey = `${host}:${upperUser}:ID_TOKEN`
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

// Exported for testing
export { parseSimpleToml as _parseSimpleToml, injectCredentialCacheSetting as _injectCredentialCacheSetting, prepareSSH as _prepareSSH }

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
  ssh: {
    name: 'SSH',
    dotfiles: [
      { path: '~/.ssh/config', readonly: true },
      { path: '~/.ssh/known_hosts', readonly: true },
    ],
    sshAgent: true,
    hostPrepare: prepareSSH,
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
  }
}
