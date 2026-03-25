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
