# Kiro CLI Auth in the Pippin Sandbox

How `kiro-cli` (the Kiro CLI) would work — or rather, why it currently
doesn't — inside the pippin sandbox.

## The Problem

The Kiro CLI (`kiro-cli`) is an AI-powered terminal coding assistant
based on Amazon Q Developer CLI. It supports the following authentication
providers:

- **AWS Builder ID** — individual developer account
- **AWS IAM Identity Center** — enterprise SSO
- **Social login** — GitHub or Google via browser-based OAuth (PKCE flow)

In all cases, after the user runs `kiro-cli login`, the resulting
access token and refresh token are stored in a **macOS keychain-backed
SQLite database** at:

```
~/Library/Application Support/amazon-q/data.sqlite3
```

Inside the pippin sandbox (a Docker container running Linux), the macOS
keychain is completely inaccessible. There is no documented environment
variable that Kiro CLI accepts in lieu of a stored token, no
`kiro-cli auth token` command to extract the token programmatically, and
no file-based credential storage option (unlike Codex's
`cli_auth_credentials_store = "file"`).

## Why We Cannot Forward Credentials

| Auth path | Works in container? | Notes |
|---|---|---|
| macOS keychain token | No | Keychain inaccessible in Linux container |
| SQLite database mount | No | Database requires write access; read-only mount breaks it |
| Environment variable | No | No documented env var credential path |
| File-based token export | No | No `kiro-cli auth token` or equivalent command |

The SQLite database is the closest thing to a mountable credential
file, but it cannot be mounted read-only: the Kiro CLI application
layer opens the database in read-write mode and the SQLite WAL journal
requires write access. A read-only bind mount causes the process to
abort on startup.

## Workaround

The only working option is to run `kiro-cli login` **inside** the
container after the sandbox starts:

```sh
pippin shell
kiro-cli login
```

Kiro CLI will print a URL and a device code. Open the URL in your host
browser, complete authentication, and the token will be written into the
container's local SQLite database. Authentication persists for the
lifetime of the container (i.e. until `pippin stop` or `pippin restart`
is run).

### Remote / device-code flow

For AWS Builder ID and IAM Identity Center, Kiro CLI uses device code
authentication automatically — it shows a URL and code, no browser
port-forwarding needed.

For social login (GitHub / Google), Kiro CLI uses a PKCE flow that
redirects to `localhost`. Inside the container this requires SSH port
forwarding (see the Kiro CLI docs on
[signing in from a remote machine](https://kiro.dev/docs/cli/authentication/#sign-in-from-a-remote-machine)).
Using Builder ID or IAM Identity Center avoids this complication.

## What Pippin Could Do (If Support Were Added)

A minimal `kiro` tool recipe would mount only the settings file:

```typescript
kiro: {
  name: 'Kiro CLI',
  dotfiles: [
    { path: '~/.kiro/settings/cli.json', readonly: true },
  ],
  // No environment vars or resolvers: there is no credential forwarding
  // path available. Auth must be completed inside the container.
},
```

This would carry over the user's preferences (model selection, telemetry
settings, MCP server configuration, etc.) into the container, but would
not carry over authentication. The user would still need to run
`kiro-cli login` inside the sandbox on every fresh container start.

A `pippin kiro [args]` subcommand would map to `kiro-cli [args]` inside
the container (the binary is named `kiro-cli`, not `kiro`).

## Relevant Paths

| Path | Purpose |
|---|---|
| `~/.kiro/settings/cli.json` | User preferences (model, telemetry, MCP config, …) |
| `~/Library/Application Support/amazon-q/data.sqlite3` | Auth tokens (macOS only, requires write access) |
| `$TMPDIR/kiro-log/` | Log files (macOS) |
| `/tmp/kiro-log/` | Log files (Linux) |
