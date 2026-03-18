import { describe, it, expect } from 'vitest'
import { resolveToolRequirements, RECIPES, KNOWN_TOOLS, _parseSimpleToml, _injectCredentialCacheSetting, _prepareSSH } from './tools'
import { expandHome } from './config'

describe('RECIPES', () => {
  it('has entries for all known tools', () => {
    for (const tool of KNOWN_TOOLS) {
      expect(RECIPES[tool]).toBeDefined()
      expect(RECIPES[tool].name).toBeTruthy()
    }
  })

  it('marks all recipe dotfiles as readonly', () => {
    for (const [, recipe] of Object.entries(RECIPES)) {
      for (const df of recipe.dotfiles ?? []) {
        expect(df.readonly).toBe(true)
      }
    }
  })
})

describe('resolveToolRequirements', () => {
  it('returns empty requirements for empty tools list', () => {
    const result = resolveToolRequirements([])
    expect(result.dotfiles).toEqual([])
    expect(result.environment).toEqual([])
    expect(result.envResolvers).toEqual({})
    expect(result.envMultiResolvers).toEqual([])
    expect(result.sshAgent).toBe(false)
    expect(result.gpgAgent).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('resolves a single tool', () => {
    const result = resolveToolRequirements(['git'])
    expect(result.dotfiles).toHaveLength(5)
    expect(result.dotfiles[0].path).toBe('~/.gitconfig')
    expect(result.dotfiles[0].readonly).toBe(true)
    expect(result.dotfiles[1].path).toBe('~/.gitignore_global')
    expect(result.dotfiles[1].readonly).toBe(true)
    expect(result.dotfiles[2].path).toBe('~/.gnupg/pubring.gpg')
    expect(result.dotfiles[2].readonly).toBe(true)
    expect(result.dotfiles[3].path).toBe('~/.gnupg/pubring.kbx')
    expect(result.dotfiles[3].readonly).toBe(true)
    expect(result.dotfiles[4].path).toBe('~/.gnupg/trustdb.gpg')
    expect(result.dotfiles[4].readonly).toBe(true)
    expect(result.sshAgent).toBe(true)
    expect(result.gpgAgent).toBe(true)
    expect(result.environment).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('resolves gh tool with env vars and dotfiles', () => {
    const result = resolveToolRequirements(['gh'])
    expect(result.dotfiles).toHaveLength(1)
    expect(result.dotfiles[0].path).toBe('~/.config/gh/config.yml')
    expect(result.environment).toContain('GITHUB_TOKEN')
    expect(result.environment).toContain('GH_TOKEN')
    expect(result.sshAgent).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('merges multiple tools', () => {
    const result = resolveToolRequirements(['git', 'gh', 'aws'])
    // git: ~/.gitconfig + ~/.gitignore_global + pubring.gpg + pubring.kbx + trustdb.gpg
    // gh: ~/.config/gh/config.yml, aws: ~/.aws/config
    expect(result.dotfiles).toHaveLength(7)
    const paths = result.dotfiles.map((d) => d.path)
    expect(paths).toContain('~/.gitconfig')
    expect(paths).toContain('~/.gitignore_global')
    expect(paths).toContain('~/.gnupg/pubring.gpg')
    expect(paths).toContain('~/.gnupg/pubring.kbx')
    expect(paths).toContain('~/.gnupg/trustdb.gpg')
    expect(paths).toContain('~/.config/gh/config.yml')
    expect(paths).toContain('~/.aws/config')
    // Environment: gh + aws env vars
    expect(result.environment).toContain('GITHUB_TOKEN')
    expect(result.environment).toContain('GH_TOKEN')
    expect(result.environment).toContain('AWS_PROFILE')
    expect(result.environment).toContain('AWS_ACCESS_KEY_ID')
    // sshAgent: git wants it
    expect(result.sshAgent).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('ORs sshAgent across tools', () => {
    // gh doesn't need sshAgent, but ssh does
    const result = resolveToolRequirements(['gh', 'ssh'])
    expect(result.sshAgent).toBe(true)
  })

  it('does not enable sshAgent when no tool needs it', () => {
    const result = resolveToolRequirements(['gh', 'aws'])
    expect(result.sshAgent).toBe(false)
  })

  it('ORs gpgAgent across tools', () => {
    // gh doesn't need gpgAgent, but git does
    const result = resolveToolRequirements(['gh', 'git'])
    expect(result.gpgAgent).toBe(true)
  })

  it('does not enable gpgAgent when no tool needs it', () => {
    const result = resolveToolRequirements(['gh', 'aws', 'ssh'])
    expect(result.gpgAgent).toBe(false)
  })

  it('deduplicates tool names', () => {
    const result = resolveToolRequirements(['git', 'git', 'git'])
    expect(result.dotfiles).toHaveLength(5)
    expect(result.dotfiles[0].path).toBe('~/.gitconfig')
    expect(result.dotfiles[1].path).toBe('~/.gitignore_global')
    expect(result.dotfiles[2].path).toBe('~/.gnupg/pubring.gpg')
    expect(result.dotfiles[3].path).toBe('~/.gnupg/pubring.kbx')
    expect(result.dotfiles[4].path).toBe('~/.gnupg/trustdb.gpg')
  })

  it('handles case-insensitive tool names', () => {
    const result = resolveToolRequirements(['Git', 'GH'])
    expect(result.dotfiles).toHaveLength(6)
    expect(result.warnings).toEqual([])
  })

  it('warns on unknown tool names', () => {
    const result = resolveToolRequirements(['git', 'terraform', 'kubectl'])
    expect(result.warnings).toEqual(['terraform', 'kubectl'])
    // git still resolves normally
    expect(result.dotfiles).toHaveLength(5)
    expect(result.dotfiles[0].path).toBe('~/.gitconfig')
  })

  it('deduplicates dotfiles by expanded path across tools', () => {
    // Both git and ssh would mount ~/.ssh/known_hosts if we had overlap.
    // Simulate by checking ssh which has two dotfiles.
    const result = resolveToolRequirements(['ssh', 'ssh'])
    expect(result.dotfiles).toHaveLength(2) // config + known_hosts, not doubled
  })

  it('resolves all known tools without errors', () => {
    const result = resolveToolRequirements(KNOWN_TOOLS)
    expect(result.warnings).toEqual([])
    expect(result.dotfiles.length).toBeGreaterThan(0)
    expect(result.sshAgent).toBe(true)
  })

  it('merges environment vars from multiple tools without duplicates', () => {
    // aws and snowflake both have unique env vars
    const result = resolveToolRequirements(['aws', 'snowflake'])
    const envSet = new Set(result.environment)
    expect(envSet.size).toBe(result.environment.length) // no duplicates
    expect(result.environment).toContain('AWS_PROFILE')
    expect(result.environment).toContain('SNOWFLAKE_DEFAULT_CONNECTION_NAME')
  })

  it('collects envResolvers from gh recipe', () => {
    const result = resolveToolRequirements(['gh'])
    expect(result.envResolvers).toEqual({ GH_TOKEN: 'gh auth token' })
  })

  it('returns empty envResolvers for tools without resolvers', () => {
    const result = resolveToolRequirements(['git', 'aws', 'ssh'])
    expect(result.envResolvers).toEqual({})
  })

  it('first resolver for a given env var wins across tools', () => {
    // gh defines GH_TOKEN resolver; if another tool also defined one,
    // the first-listed tool's resolver should take priority.
    // For now, only gh has resolvers — verify it still works when merged.
    const result = resolveToolRequirements(['git', 'gh', 'aws'])
    expect(result.envResolvers).toEqual({ GH_TOKEN: 'gh auth token' })
  })

  it('deduplicates envResolvers when tool is listed twice', () => {
    const result = resolveToolRequirements(['gh', 'gh'])
    expect(result.envResolvers).toEqual({ GH_TOKEN: 'gh auth token' })
  })

  it('collects envMultiResolver from aws recipe', () => {
    const result = resolveToolRequirements(['aws'])
    expect(result.envMultiResolvers).toEqual([
      'aws configure export-credentials --format env-no-export',
    ])
  })

  it('returns empty envMultiResolvers for tools without multi-resolvers', () => {
    const result = resolveToolRequirements(['git', 'gh', 'ssh'])
    expect(result.envMultiResolvers).toEqual([])
  })

  it('deduplicates envMultiResolvers when tool is listed twice', () => {
    const result = resolveToolRequirements(['aws', 'aws'])
    expect(result.envMultiResolvers).toHaveLength(1)
  })

  it('aws recipe mounts only config file, not the whole directory', () => {
    const result = resolveToolRequirements(['aws'])
    expect(result.dotfiles).toHaveLength(1)
    expect(result.dotfiles[0].path).toBe('~/.aws/config')
    expect(result.dotfiles[0].readonly).toBe(true)
  })

  it('aws recipe includes credential expiration env var', () => {
    const result = resolveToolRequirements(['aws'])
    expect(result.environment).toContain('AWS_CREDENTIAL_EXPIRATION')
  })

  it('snowflake recipe mounts only config.toml, not the whole directory', () => {
    const result = resolveToolRequirements(['snowflake'])
    expect(result.dotfiles).toHaveLength(1)
    expect(result.dotfiles[0].path).toBe('~/.snowflake/config.toml')
    expect(result.dotfiles[0].readonly).toBe(true)
  })

  it('snowflake recipe has a hostPrepare function', () => {
    const result = resolveToolRequirements(['snowflake'])
    expect(result.hostPrepares).toHaveLength(1)
    expect(typeof result.hostPrepares[0]).toBe('function')
  })

  it('collects hostPrepares from recipes that define them', () => {
    // snowflake and ssh both have hostPrepare
    const result = resolveToolRequirements(['git', 'gh', 'snowflake', 'aws', 'ssh'])
    expect(result.hostPrepares).toHaveLength(2)
  })

  it('does not collect hostPrepares from recipes without them', () => {
    const result = resolveToolRequirements(['git', 'gh', 'aws'])
    expect(result.hostPrepares).toHaveLength(0)
  })
})

describe('parseSimpleToml', () => {
  it('parses flat key-value pairs', () => {
    const result = _parseSimpleToml('foo = "bar"\nbaz = "qux"')
    expect(result).toEqual({ foo: 'bar', baz: 'qux' })
  })

  it('parses keys under section headers', () => {
    const result = _parseSimpleToml('[section]\nkey = "value"')
    expect(result).toEqual({ 'section.key': 'value' })
  })

  it('parses nested section headers', () => {
    const result = _parseSimpleToml('[a.b]\nkey = "value"')
    expect(result).toEqual({ 'a.b.key': 'value' })
  })

  it('parses a snowflake config.toml', () => {
    const toml = `
default_connection_name = "dev-us-east-1"

[connections]
[connections.dev-us-east-1]
account = "myaccount.us-east-1.privatelink"
user = "USER@EXAMPLE.COM"
authenticator = "externalbrowser"
role = "MY_ROLE"
warehouse = "MY_WH"
`
    const result = _parseSimpleToml(toml)
    expect(result['default_connection_name']).toBe('dev-us-east-1')
    expect(result['connections.dev-us-east-1.account']).toBe('myaccount.us-east-1.privatelink')
    expect(result['connections.dev-us-east-1.user']).toBe('USER@EXAMPLE.COM')
    expect(result['connections.dev-us-east-1.authenticator']).toBe('externalbrowser')
  })

  it('handles single-quoted values', () => {
    const result = _parseSimpleToml("key = 'value'")
    expect(result).toEqual({ key: 'value' })
  })

  it('handles unquoted values', () => {
    const result = _parseSimpleToml('key = true')
    expect(result).toEqual({ key: 'true' })
  })

  it('ignores comments and blank lines', () => {
    const result = _parseSimpleToml('# comment\n\nkey = "value"\n# another comment')
    expect(result).toEqual({ key: 'value' })
  })
})

describe('injectCredentialCacheSetting', () => {
  it('adds client_store_temporary_credential to connection sections', () => {
    const input = `
default_connection_name = "default"

[connections]
[connections.default]
account = "myaccount"
user = "me@example.com"
authenticator = "externalbrowser"
`
    const result = _injectCredentialCacheSetting(input)
    expect(result).toContain('client_store_temporary_credential = true')
    // Should appear after the connection settings
    const lines = result.split('\n')
    const settingIdx = lines.findIndex((l) => l.trim() === 'client_store_temporary_credential = true')
    const sectionIdx = lines.findIndex((l) => l.trim() === '[connections.default]')
    expect(settingIdx).toBeGreaterThan(sectionIdx)
  })

  it('does not duplicate the setting if already present', () => {
    const input = `
[connections.default]
account = "myaccount"
client_store_temporary_credential = true
authenticator = "externalbrowser"
`
    const result = _injectCredentialCacheSetting(input)
    const count = (result.match(/client_store_temporary_credential/g) || []).length
    expect(count).toBe(1)
  })

  it('handles multiple connection sections', () => {
    const input = `
[connections.one]
account = "acc1"

[connections.two]
account = "acc2"
`
    const result = _injectCredentialCacheSetting(input)
    const count = (result.match(/client_store_temporary_credential = true/g) || []).length
    expect(count).toBe(2)
  })

  it('does not inject into the bare [connections] section', () => {
    const input = `
[connections]
[connections.default]
account = "myaccount"
`
    const result = _injectCredentialCacheSetting(input)
    const lines = result.split('\n')
    // The setting should only appear after [connections.default], not after [connections]
    const connectionsIdx = lines.findIndex((l) => l.trim() === '[connections]')
    const defaultIdx = lines.findIndex((l) => l.trim() === '[connections.default]')
    const settingIdx = lines.findIndex((l) => l.trim() === 'client_store_temporary_credential = true')
    expect(settingIdx).toBeGreaterThan(defaultIdx)
  })
})

describe('SSH recipe', () => {
  it('ssh recipe has a hostPrepare function', () => {
    const result = resolveToolRequirements(['ssh'])
    expect(result.hostPrepares).toHaveLength(1)
    expect(typeof result.hostPrepares[0]).toBe('function')
  })
})
