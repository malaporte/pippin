## [0.20.2](https://github.com/malaporte/pippin/compare/v0.20.1...v0.20.2) (2026-04-10)


### Bug Fixes

* **ci:** explicitly ad-hoc sign darwin binaries after bun compile ([372becd](https://github.com/malaporte/pippin/commit/372becd5d83f876384f32584a756a17f92b0093f))
* **ci:** pin bun to 1.3.11 on macos runner to get properly signed binaries ([b98dc13](https://github.com/malaporte/pippin/commit/b98dc135909e5d018ab0cba2224cf8d0bc7d1560))
* **ci:** remove --preserve-metadata from codesign to fix signing of bun binaries ([83a7abf](https://github.com/malaporte/pippin/commit/83a7abffa9cc479d1d76c4e83bd1a86c04c1bc85))

## [0.20.1](https://github.com/malaporte/pippin/compare/v0.20.0...v0.20.1) (2026-04-10)


### Bug Fixes

* **ci:** build darwin binaries on macos runner to preserve ad-hoc signature ([644cfa1](https://github.com/malaporte/pippin/commit/644cfa1113f12954158cbf66936087f0221984a2))
* **ci:** replace codesign -v with smoke test to verify darwin binary runs ([e86158d](https://github.com/malaporte/pippin/commit/e86158deb157f0f38978339c108e6e95ffaacde6))
* **ci:** use codesign -d to verify adhoc signature instead of codesign -v ([e0d717e](https://github.com/malaporte/pippin/commit/e0d717e6a580007f1bc18b3edc32777c457d56aa))

# [0.20.0](https://github.com/malaporte/pippin/compare/v0.19.0...v0.20.0) (2026-04-10)


### Features

* remove more references to leash ([2b164ed](https://github.com/malaporte/pippin/commit/2b164ed9ed8b49601e9cd2a83dc8fdcd596b063b))

# [0.19.0](https://github.com/malaporte/pippin/compare/v0.18.0...v0.19.0) (2026-04-10)


### Features

* trigger release ([71f7248](https://github.com/malaporte/pippin/commit/71f7248cbda1430a39710152b60eecb4b4fd7918))

# [0.18.0](https://github.com/malaporte/pippin/compare/v0.17.0...v0.18.0) (2026-04-08)


### Features

* **sandbox:** forward host service ports into sandbox localhost ([#29](https://github.com/malaporte/pippin/issues/29)) ([c2b1c6e](https://github.com/malaporte/pippin/commit/c2b1c6e4d74ebde320ce528d0feafa9694140abb))

# [0.17.0](https://github.com/malaporte/pippin/compare/v0.16.0...v0.17.0) (2026-04-08)


### Features

* trigger new release ([cc6ae46](https://github.com/malaporte/pippin/commit/cc6ae469f6f11f0c82a81d4e88f0edf8b03c53d9))

# [0.16.0](https://github.com/malaporte/pippin/compare/v0.15.0...v0.16.0) (2026-04-02)


### Features

* remove pippin run subcommand in favour of -c interface ([#27](https://github.com/malaporte/pippin/issues/27)) ([c3bf10e](https://github.com/malaporte/pippin/commit/c3bf10e25dec672207d7118f43e76dc6eecb2477))

# [0.15.0](https://github.com/malaporte/pippin/compare/v0.14.0...v0.15.0) (2026-04-02)


### Features

* add POSIX shell -c interface for Node spawn compatibility ([#26](https://github.com/malaporte/pippin/issues/26)) ([969f963](https://github.com/malaporte/pippin/commit/969f963fef3799f969efebf6aa39cb039698a0e4))

# [0.14.0](https://github.com/malaporte/pippin/compare/v0.13.1...v0.14.0) (2026-04-01)


### Features

* replace .pippin.toml with path-keyed workspaces in global config ([#25](https://github.com/malaporte/pippin/issues/25)) ([de3a382](https://github.com/malaporte/pippin/commit/de3a38292e881ac8a206e9e085575fc9261492ba))

## [0.13.1](https://github.com/malaporte/pippin/compare/v0.13.0...v0.13.1) (2026-03-30)


### Bug Fixes

* run pre-commit install in container to fix stale INSTALL_PYTHON in git hooks ([#24](https://github.com/malaporte/pippin/issues/24)) ([a320a06](https://github.com/malaporte/pippin/commit/a320a06aef9261265c6e49ba4441c84d41c9f74d))

# [0.13.0](https://github.com/malaporte/pippin/compare/v0.12.0...v0.13.0) (2026-03-27)


### Features

* make sandbox init timeout configurable globally and per-workspace ([#23](https://github.com/malaporte/pippin/issues/23)) ([6a7bf9f](https://github.com/malaporte/pippin/commit/6a7bf9f26558da4699af32df624a4770208bb85e))

# [0.12.0](https://github.com/malaporte/pippin/compare/v0.11.1...v0.12.0) (2026-03-27)


### Features

* add sentry-cli tool recipe and install in default sandbox image ([#22](https://github.com/malaporte/pippin/issues/22)) ([29e04af](https://github.com/malaporte/pippin/commit/29e04af088d3931738c159c7d9d88226b31437f2))

## [0.11.1](https://github.com/malaporte/pippin/compare/v0.11.0...v0.11.1) (2026-03-27)


### Bug Fixes

* warn instead of failing when sandbox init command fails ([#21](https://github.com/malaporte/pippin/issues/21)) ([8a4ddfc](https://github.com/malaporte/pippin/commit/8a4ddfc5702039861f6ded9747af2d2e549ef5c0))

# [0.11.0](https://github.com/malaporte/pippin/compare/v0.10.0...v0.11.0) (2026-03-26)


### Features

* **uv:** use linux-specific venv and auto-run setup script ([#20](https://github.com/malaporte/pippin/issues/20)) ([0846cc3](https://github.com/malaporte/pippin/commit/0846cc35fca406974905fd2577b19b2dc640081b))

# [0.10.0](https://github.com/malaporte/pippin/compare/v0.9.0...v0.10.0) (2026-03-26)


### Features

* **sandbox:** auto-detect and run uv install in fresh sandboxes ([#19](https://github.com/malaporte/pippin/issues/19)) ([ab749fb](https://github.com/malaporte/pippin/commit/ab749fb235c46e00ec15187a3a8ea8abc60adec1))

# [0.9.0](https://github.com/malaporte/pippin/compare/v0.8.1...v0.9.0) (2026-03-26)


### Features

* auto-detect and run package-manager install in fresh sandboxes ([#18](https://github.com/malaporte/pippin/issues/18)) ([96cd35e](https://github.com/malaporte/pippin/commit/96cd35e40b871af2fc2ae1e51ef7e43951a5e8a3))

## [0.8.1](https://github.com/malaporte/pippin/compare/v0.8.0...v0.8.1) (2026-03-26)


### Bug Fixes

* **sandbox:** harden gpg agent forwarding ([#17](https://github.com/malaporte/pippin/issues/17)) ([6f1a8e8](https://github.com/malaporte/pippin/commit/6f1a8e8f8f7a95fe03652bca620779bc90242286))

# [0.8.0](https://github.com/malaporte/pippin/compare/v0.7.3...v0.8.0) (2026-03-25)


### Features

* add Jira CLI to default sandbox and tool recipe ([#16](https://github.com/malaporte/pippin/issues/16)) ([83799ce](https://github.com/malaporte/pippin/commit/83799ced889ee220965d3b4d26a2d967ff044238))

## [0.7.3](https://github.com/malaporte/pippin/compare/v0.7.2...v0.7.3) (2026-03-24)


### Bug Fixes

* **sandbox:** chmod 700 /root/.gnupg at bootstrap to fix GPG agent forwarding ([#15](https://github.com/malaporte/pippin/issues/15)) ([86535b9](https://github.com/malaporte/pippin/commit/86535b937f53e811cfaa952af8d9c6e3da74d92b))

## [0.7.2](https://github.com/malaporte/pippin/compare/v0.7.1...v0.7.2) (2026-03-24)


### Bug Fixes

* show clear error when sandbox.init command fails ([#14](https://github.com/malaporte/pippin/issues/14)) ([30eb209](https://github.com/malaporte/pippin/commit/30eb2096003a12b3b72524efca599869984e4e9a))

## [0.7.1](https://github.com/malaporte/pippin/compare/v0.7.0...v0.7.1) (2026-03-24)


### Bug Fixes

* **sandbox:** use identity mapping for sandbox.mounts, parse ssh_agent and tools from config ([#13](https://github.com/malaporte/pippin/issues/13)) ([cc9d0e1](https://github.com/malaporte/pippin/commit/cc9d0e17769ad30b56a252c65419faaf8f277136))

# [0.7.0](https://github.com/malaporte/pippin/compare/v0.6.4...v0.7.0) (2026-03-24)


### Bug Fixes

* pass empty array for toolExtraMounts in loopback binding test ([bea54cd](https://github.com/malaporte/pippin/commit/bea54cd5d2511232a9b29771dac74fa473e0be13))


### Features

* **tools:** add pnpm recipe to mount host store into sandbox ([#12](https://github.com/malaporte/pippin/issues/12)) ([6bc0af5](https://github.com/malaporte/pippin/commit/6bc0af598be0b3be3ef9633362729411b5b9cb58))

## [0.6.4](https://github.com/malaporte/pippin/compare/v0.6.3...v0.6.4) (2026-03-24)


### Bug Fixes

* bind sandbox ports to loopback, retry on port conflicts, and clean up all leash containers ([#11](https://github.com/malaporte/pippin/issues/11)) ([254b5fd](https://github.com/malaporte/pippin/commit/254b5fdebefb72e4b935e58b2ce027b164c17e15))

## [0.6.3](https://github.com/malaporte/pippin/compare/v0.6.2...v0.6.3) (2026-03-24)


### Bug Fixes

* probe host ports before allocating to prevent container start failures ([#10](https://github.com/malaporte/pippin/issues/10)) ([fa4b5af](https://github.com/malaporte/pippin/commit/fa4b5af0538eab483e6542c85eeb5a99f74fd0d2))

## [0.6.2](https://github.com/malaporte/pippin/compare/v0.6.1...v0.6.2) (2026-03-23)


### Bug Fixes

* use unique container names to prevent cross-workspace collisions ([#9](https://github.com/malaporte/pippin/issues/9)) ([fc42f93](https://github.com/malaporte/pippin/commit/fc42f9379904fc1f183c7415c97bdc728726c3c6))

## [0.6.1](https://github.com/malaporte/pippin/compare/v0.6.0...v0.6.1) (2026-03-23)


### Bug Fixes

* **refactor:** remove now unused release skill ([8ffd41d](https://github.com/malaporte/pippin/commit/8ffd41dca14d600f89c7b2b0603caf95d14823da))

# [0.6.0](https://github.com/malaporte/pippin/compare/v0.5.0...v0.6.0) (2026-03-23)


### Bug Fixes

* **ci:** add Node.js 22 setup for semantic-release compatibility ([8771771](https://github.com/malaporte/pippin/commit/8771771fdc8a0b1bcd9f1354e536c679c327f9f0))


### Features

* automate releases with semantic-release ([#8](https://github.com/malaporte/pippin/issues/8)) ([cd5c6f4](https://github.com/malaporte/pippin/commit/cd5c6f4aff9509de617fa614521728a0808f5271))
