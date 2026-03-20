# OpenAI Codex CLI Auth in the Pippin Sandbox

How `codex` works inside the pippin sandbox without macOS keychain access.

## The Problem

The OpenAI Codex CLI (`codex`) supports two authentication methods:

1. **API key** -- Set `OPENAI_API_KEY` in the environment.
2. **`codex login`** -- Browser-based OAuth that caches an access token.

When using `codex login`, the cached token is stored either in the macOS
keychain (the default on macOS) or in a plaintext file at
`~/.codex/auth.json`. Inside the pippin sandbox (a Docker container
running Linux), the macOS keychain is inaccessible.

## How We Solve It

The `codex` tool recipe uses two complementary strategies to cover the
common authentication flows:

1. **Forward `OPENAI_API_KEY`** -- If the user has `OPENAI_API_KEY` set
   in their host environment, it is forwarded into the container. This
   is the standard API-key authentication path and works without any
   credential files.

2. **Mount `~/.codex/auth.json`** (readonly) -- If the user has
   authenticated via `codex login` with file-based credential storage
   (`cli_auth_credentials_store = "file"` in `~/.codex/config.toml`),
   the cached token file is mounted into the container. Codex reads it
   and authenticates without needing the keychain.

3. **Mount `~/.codex/config.toml`** (readonly) -- The user's
   configuration (model selection, provider settings, approval policy,
   sandbox preferences) is mounted so Codex inside the container uses
   the same settings as on the host.

## Keychain-Based Auth

If you use `codex login` with the default keychain storage, the cached
token is stored in the macOS keychain and `~/.codex/auth.json` does not
exist. In this case, Codex inside the container cannot access the token.

Unlike the GitHub CLI (which provides `gh auth token` to extract the
token programmatically), the Codex CLI does not expose a command to
print the cached token from the keychain. There are two workarounds:

### Option A: Switch to file-based credential storage

Add this to `~/.codex/config.toml`:

```toml
cli_auth_credentials_store = "file"
```

Then run `codex login` again. The token will be saved to
`~/.codex/auth.json` and pippin will mount it into the container.

### Option B: Use an API key instead

Set `OPENAI_API_KEY` in your shell environment (e.g. in `~/.zshrc`):

```sh
export OPENAI_API_KEY="sk-..."
```

Pippin forwards this into the container automatically.

## Token Expiry

Tokens cached via `codex login` are auto-refreshed during active
sessions on the host. Inside the container, the mounted `auth.json` is
a point-in-time snapshot from sandbox start. If the token expires during
a long session, Codex commands will fail.

Recovery: run `codex login` on the host, then restart the sandbox with
`pippin restart`.

## Custom Providers

Codex supports custom model providers via `config.toml`:

```toml
model_provider = "proxy"

[model_providers.proxy]
base_url = "http://proxy.example.com"
env_key = "OPENAI_API_KEY"
```

The `env_key` env var is resolved from the host environment. If your
custom provider uses a different env var (e.g. `AZURE_OPENAI_API_KEY`),
add it to the `environment` list in your pippin global config:

```json
{
  "tools": ["codex"],
  "environment": ["AZURE_OPENAI_API_KEY"]
}
```

## Reference

| Property | Value |
|---|---|
| Mounted files | `~/.codex/config.toml` (readonly), `~/.codex/auth.json` (readonly) |
| Env vars forwarded | `OPENAI_API_KEY` |
| Auth mechanism in container | `OPENAI_API_KEY` env var or `auth.json` file |

## Relevant Source Locations

**Pippin:**
- `src/cli/tools.ts` -- `codex` recipe definition
