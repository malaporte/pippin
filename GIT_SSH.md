# Git, SSH & GPG Auth in the Pippin Sandbox

How `git push`, SSH connections, and GPG commit signing work inside the
pippin sandbox without copying private keys into the container.

## The Problem

Git remote operations (push, pull, fetch) need SSH authentication.
Commit signing needs GPG private keys. Both involve secret key material
that should never be copied into a container:

- **SSH keys** are stored in `~/.ssh/` or the macOS keychain. Copying
  them into the container means a compromised sandbox could exfiltrate
  them permanently.
- **GPG private keys** live in `~/.gnupg/private-keys-v1.d/`. Same
  risk — once copied, they can't be un-compromised.
- **macOS SSH config** uses Apple-specific directives (`UseKeychain`,
  `AddKeysToAgent`) that Linux OpenSSH rejects with "Bad configuration
  option", causing all SSH connections to fail.

The sandbox needs to perform SSH and GPG operations using the host's
keys without ever seeing the key material.

## How We Solve It — SSH

The `git` and `ssh` tool recipes combine SSH agent forwarding with
config sanitization:

### 1. SSH Agent Forwarding

Docker Desktop for Mac exposes the host's SSH agent inside containers
via a proxy socket at `/run/host-services/ssh-auth.sock`. Pippin
bind-mounts this socket and sets `SSH_AUTH_SOCK` in the container
environment.

When `git push` (or any SSH client) runs inside the container, it
connects to the forwarded agent socket. The agent — running on the
host — performs the cryptographic signing using the private key. The
container only sees the signed challenge response, never the key itself.

### 2. Automatic Key Loading

SSH on macOS can authenticate by reading private key files directly
from `~/.ssh/` — the keys don't need to be loaded into the SSH agent.
Inside the container, however, key files are intentionally not mounted
(to prevent exfiltration), so only the forwarded agent path works. If
the agent is empty, SSH operations inside the sandbox fail with
"Permission denied (publickey)".

Pippin bridges this gap automatically. At sandbox start, the `ssh`
tool recipe's host-side prepare step:

1. Discovers candidate identity files by parsing `~/.ssh/config` for
   `IdentityFile` directives and checking the well-known default paths
   (`id_rsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, `id_ed25519_sk`).
2. Queries the running SSH agent (`ssh-add -l`) to see which keys are
   already loaded.
3. For each key that exists on disk but is missing from the agent, runs
   `ssh-add --apple-use-keychain <path>` to load it. The
   `--apple-use-keychain` flag retrieves the passphrase from the macOS
   Keychain if it was stored there; for passphrase-less keys it is
   harmless.

This is logged to stderr:

```
pippin: added /Users/you/.ssh/id_rsa to SSH agent
```

If `ssh-add` fails for a particular key (e.g. passphrase not in the
Keychain and no TTY available for interactive prompting), that key is
silently skipped. You can always load keys manually with `ssh-add`
before starting the sandbox.

### 3. SSH Config and Known Hosts

The `ssh` recipe mounts two files read-only:

- `~/.ssh/config` — Host aliases, per-host identity files, proxy
  settings. Mounted so that `ssh myserver` resolves the same way inside
  the container as on the host.
- `~/.ssh/known_hosts` — Cached host public keys. Mounted so SSH
  doesn't prompt for host key verification in the non-interactive
  container.

### 4. macOS SSH Config Sanitization

macOS's default `~/.ssh/config` commonly includes Apple-specific
options:

```
Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_rsa
```

`UseKeychain` and `AddKeysToAgent` (with the `yes` value triggering
keychain integration) are extensions added by Apple's fork of OpenSSH.
The upstream OpenSSH shipped in Linux containers doesn't recognize them
and aborts with:

```
/root/.ssh/config: line 3: Bad configuration option: usekeychain
```

Pippin's `prepareSSH()` function detects these macOS-specific options
and generates a sanitized copy of the config. It prepends an
`IgnoreUnknown` directive — an official OpenSSH escape hatch (available
since OpenSSH 6.3) that tells the parser to silently skip unknown
keywords:

```
# Added by pippin: ignore macOS-specific SSH options on Linux
IgnoreUnknown UseKeychain,AddKeysToAgent

Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_rsa
```

The sanitized file is written to a temp directory and bind-mounted in
place of the original. The host's `~/.ssh/config` is never modified.

## How We Solve It — GPG Commit Signing

The `git` recipe forwards the GPG agent socket so that `git commit -S`
works without copying private keys:

### 1. Public Keyring Mounting

Three files from `~/.gnupg/` are mounted read-only:

- `pubring.gpg` / `pubring.kbx` — Public keyring (GPG needs to know
  which key to use for signing, and to verify existing signatures)
- `trustdb.gpg` — Trust database (key validity/trust levels)

Private keys (`private-keys-v1.d/`) are **never** mounted.

### 2. GPG Agent Socket Forwarding

Pippin locates the host's `gpg-agent` socket by running:

```
gpgconf --list-dirs agent-socket
```

This returns a path like `/Users/martin/.gnupg/S.gpg-agent` (or a
path under `/private/var/` on some macOS configurations). Pippin
bind-mounts this socket to `/root/.gnupg/S.gpg-agent` inside the
container.

When `git commit -S` invokes `gpg --sign`, the GPG client inside the
container connects to the forwarded agent socket. The host's
`gpg-agent` performs the signing operation, handling pinentry
(passphrase prompts) natively on the host side. The container receives
only the detached signature — never the private key.

## How We Solve It — Git Config

The `git` recipe mounts two files read-only:

- `~/.gitconfig` — User name, email, signing key, aliases, default
  branch, and other preferences. Ensures commits inside the container
  use the same identity as on the host.
- `~/.gitignore_global` — Global ignore patterns.

## Why Agent Forwarding Instead of Key Copying

Agent forwarding is a deliberate security choice:

- **No key exfiltration**: Private keys exist only on the host. The
  container can *request signatures* through the agent socket but cannot
  read the key material. If the container is compromised, the attacker
  can use the agent while the container is running but cannot steal keys
  for later use.
- **No key management**: There's no need to generate container-specific
  keys, add them to GitHub/GitLab, or rotate them. The container uses
  whatever keys are loaded in the host's agent.
- **Passphrase handling**: For GPG, the host's `gpg-agent` handles
  pinentry natively (a macOS dialog or terminal prompt). The container
  doesn't need a pinentry program.

## Limitations

- **Docker Desktop only**: SSH agent forwarding uses Docker Desktop for
  Mac's `/run/host-services/ssh-auth.sock` proxy. This does not work
  with Colima, OrbStack, or remote Docker hosts.
- **Default agent only**: Docker Desktop proxies the macOS default
  launchd SSH agent. Non-default agents (1Password SSH agent, Secretive,
  `gpg-agent` as SSH agent) are not forwarded.
- **GPG agent requires `gpg-agent` on host**: If `gpg-agent` is not
  running or `gpgconf` is not installed, GPG socket forwarding is
  silently skipped. Signing operations inside the container will fail.
- **No interactive pinentry in container**: If the host's `gpg-agent`
  cache has expired and needs a passphrase, the pinentry dialog appears
  on the host. If no one is at the host to enter the passphrase, the
  signing operation hangs.

## Reference — SSH

| Property | Value |
|---|---|
| Agent socket (host) | `/run/host-services/ssh-auth.sock` (Docker Desktop proxy) |
| Agent socket (container) | `/run/host-services/ssh-auth.sock` |
| Env var | `SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock` |
| Mounted files | `~/.ssh/config` (readonly, sanitized), `~/.ssh/known_hosts` (readonly) |
| Sanitization | Prepends `IgnoreUnknown UseKeychain,AddKeysToAgent` if macOS options detected |
| Auto key loading | Runs `ssh-add --apple-use-keychain` for identity files found in `~/.ssh/config` and well-known defaults |

## Reference — GPG

| Property | Value |
|---|---|
| Agent socket (host) | Output of `gpgconf --list-dirs agent-socket` |
| Agent socket (container) | `/root/.gnupg/S.gpg-agent` |
| Mounted files | `~/.gnupg/pubring.gpg` (readonly), `~/.gnupg/pubring.kbx` (readonly), `~/.gnupg/trustdb.gpg` (readonly) |
| Private keys mounted | **No** — never mounted |

## Reference — Git

| Property | Value |
|---|---|
| Mounted files | `~/.gitconfig` (readonly), `~/.gitignore_global` (readonly) |
| Requires | `sshAgent: true`, `gpgAgent: true` |

## Relevant Source Locations

**Pippin:**
- `src/cli/tools.ts` — `git` recipe (line 489), `ssh` recipe (line 547), `prepareSSH()` (line 451), `ensureAgentHasKeys()` (line 375), `discoverIdentityFiles()` (line 330)
- `src/cli/sandbox.ts` — SSH agent socket mount (line 628), GPG agent socket mount (line 649), `known_hosts` auto-mount (line 636)

**OpenSSH:**
- `ssh_config(5)` — `IgnoreUnknown` directive documentation
- Apple's OpenSSH fork adds `UseKeychain` and `AddKeysToAgent` keychain integration

**GnuPG:**
- `gpg-agent(1)` — Agent socket, pinentry, and `--extra-socket` for remote forwarding
- `gpgconf(1)` — `--list-dirs agent-socket` for locating the agent socket
