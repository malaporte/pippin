# Skill: release

## Purpose

Walk through creating a new Pippin release: read the current version, inspect
commits since the last tag to recommend a semver bump, update `package.json`,
run quality gates, commit, tag, and push to trigger the CI/CD release pipeline.

## Semver Rules

This project follows [Semantic Versioning](https://semver.org/):

| Situation | Bump |
|-----------|------|
| Any commit with `!` suffix or `BREAKING CHANGE:` in body | **major** (`X.0.0`) |
| Any `feat:` commit | **minor** (`x.Y.0`) |
| Any `fix:`, `perf:`, `refactor:` commit | **patch** (`x.y.Z`) |
| Only `docs:`, `chore:`, `ci:`, `test:`, `style:` | **patch** (or consider skipping the release) |

Commits use [Conventional Commits](https://www.conventionalcommits.org/) prefixes.
The highest-priority rule across all commits since the last tag wins.

## Instructions

### Step 1: Check for Uncommitted Changes

```bash
git status --porcelain
```

If the output is non-empty, **stop** and ask the user to commit or stash their
changes before proceeding.

### Step 2: Read the Current Version

Read the `"version"` field from `package.json` (e.g. `"0.1.15"`).
Store this as `{current_version}`.

### Step 3: Find the Last Tag and Inspect Commits

```bash
git describe --tags --abbrev=0
```

Store the result as `{last_tag}` (e.g. `v0.1.15`).

If no tag exists, skip ahead to Step 4 and ask the user to provide the full
version number manually.

List commits since the last tag:

```bash
git log {last_tag}..HEAD --oneline
```

If there are **no commits** since the last tag, inform the user and stop:

```
No commits found since {last_tag}. There is nothing to release.
```

Otherwise, apply the semver rules above to determine the recommended bump type.
Present your reasoning clearly, for example:

```
Current version : 0.1.15
Commits since v0.1.15:
  996b0ef Add codex and copilot tool recipes, install MITM CA into system store
  87d13ae Add top-level pippin codex and pippin copilot CLI commands

Analysis:
  - 2 x feat  -> minor bump recommended

Recommended next version: 0.2.0  (minor bump)
```

Ask the user to confirm or provide a different version before continuing.
Store the confirmed version as `{new_version}` (without the `v` prefix, e.g. `0.2.0`).

### Step 4: Update package.json

Edit `package.json`, changing the `"version"` field from `{current_version}` to
`{new_version}`.

Verify the change looks correct before continuing.

### Step 5: Run Quality Gates

Run typecheck and tests to make sure the release is clean:

```bash
bun run typecheck
bun run test
```

If either command fails, **stop** and ask the user to fix the issues before
proceeding. Do not commit a broken release.

### Step 6: Commit the Version Bump

```bash
git add package.json
git commit -m "chore: bump version to v{new_version}"
```

### Step 7: Deploy Locally

Build and deploy the CLI binary to `~/.local/bin/pippin` so the developer's
local install is up to date:

```bash
bun run deploy:cli
```

### Step 8: Create the Git Tag

Check that the tag does not already exist:

```bash
git tag -l "v{new_version}"
```

If it already exists, **stop** and warn the user before proceeding.

Otherwise create the tag:

```bash
git tag v{new_version}
```

### Step 9: Push Commit and Tag

```bash
git push && git push --tags
```

### Step 10: Confirm

Report success:

```
Released v{new_version}.

The tag push has triggered the release workflow, which will:
  1. Typecheck and test
  2. Build cross-platform binaries (macOS + Linux, x64 + arm64)
  3. Package them as tarballs
  4. Create a GitHub Release with auto-generated release notes

Users can update via `pippin update` or the curl installer.
```
