#!/bin/sh
# Pippin installer
# Usage: curl -fsSL https://raw.githubusercontent.com/malaporte/pippin/main/scripts/install.sh | bash
# Or with options:
#   PIPPIN_VERSION=0.1.1 curl -fsSL ... | bash
#   PIPPIN_INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash

set -eu

REPO="malaporte/pippin"
INSTALL_DIR="${PIPPIN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${PIPPIN_VERSION:-}"

# ---- Helpers ----------------------------------------------------------------

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
  fi
}

download() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    err "neither curl nor wget found; please install one and retry"
  fi
}

# ---- Detect OS / arch -------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  *)      err "unsupported OS: $OS" ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64"   ;;
  *)             err "unsupported architecture: $ARCH" ;;
esac

# ---- Resolve version --------------------------------------------------------

if [ -z "$VERSION" ]; then
  say "Fetching latest release version..."
  RELEASES_URL="https://api.github.com/repos/${REPO}/releases/latest"
  TMP_JSON="$(mktemp)"
  download "$RELEASES_URL" "$TMP_JSON"
  VERSION="$(sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' "$TMP_JSON" | head -1)"
  rm -f "$TMP_JSON"
  if [ -z "$VERSION" ]; then
    err "could not determine latest version from GitHub API"
  fi
fi

say "Installing pippin v${VERSION} (${OS}-${ARCH})..."

# ---- Download & extract -----------------------------------------------------

BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
CLI_TARBALL="pippin-${OS}-${ARCH}.tar.gz"
SERVER_TARBALL="pippin-server-linux-${ARCH}.tar.gz"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

say "Downloading CLI binary..."
download "${BASE_URL}/${CLI_TARBALL}" "${TMP_DIR}/${CLI_TARBALL}"

say "Downloading server binary..."
download "${BASE_URL}/${SERVER_TARBALL}" "${TMP_DIR}/${SERVER_TARBALL}"

tar -xzf "${TMP_DIR}/${CLI_TARBALL}"    -C "$TMP_DIR"
tar -xzf "${TMP_DIR}/${SERVER_TARBALL}" -C "$TMP_DIR"

# ---- Install ----------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

# Install CLI binary as "pippin"
install -m 755 "${TMP_DIR}/pippin-${OS}-${ARCH}" "${INSTALL_DIR}/pippin"

# Install server binary co-located with the CLI (required for container startup)
install -m 755 "${TMP_DIR}/pippin-server-linux-${ARCH}" "${INSTALL_DIR}/pippin-server-linux-${ARCH}"

# ---- Done -------------------------------------------------------------------

say ""
say "pippin v${VERSION} installed to ${INSTALL_DIR}/pippin"

# Check PATH
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    say ""
    say "warning: ${INSTALL_DIR} is not on your PATH"
    say "add it with:  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
