#!/bin/sh
# openEMS GUI installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/tscircuit/openems-gui/main/install.sh | sh
#
# Installs the desktop app for the current user and pre-downloads the openEMS
# engine so the first simulation works offline. Nothing needs sudo.
#
# Options (environment variables):
#   OPENEMS_GUI_VERSION=v0.1.0      install a specific release instead of the latest
#   OPENEMS_GUI_SKIP_ENGINE=1       do not download the openEMS engine (the app can do it later,
#                                   or use an openEMS you installed yourself / Docker)
#   OPENEMS_GUI_APP_DIR=<dir>       where to put the app (macOS: default /Applications or ~/Applications)
#   OPENEMS_GUI_DATA=<dir>          app data directory (engine, simulation runs)
set -eu

REPO="tscircuit/openems-gui"
ENGINE_TAG="engine-v0.37.0-1"

VERSION="${OPENEMS_GUI_VERSION:-latest}"
if [ "$VERSION" = latest ]; then
  APP_BASE="${OPENEMS_GUI_DOWNLOAD_BASE:-https://github.com/$REPO/releases/latest/download}"
else
  APP_BASE="${OPENEMS_GUI_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/$VERSION}"
fi
ENGINE_BASE="${OPENEMS_GUI_ENGINE_BASE:-https://github.com/$REPO/releases/download/$ENGINE_TAG}"

say() { printf '%s\n' "$*"; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# fetch <url> <destination>; also accepts local paths / file:// URLs (used by the tests)
fetch() {
  case "$1" in
    file://*) cp "${1#file://}" "$2" ;;
    /*) cp "$1" "$2" ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fL --progress-bar --retry 3 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then
        wget -q --show-progress -O "$2" "$1"
      else
        fail "curl or wget is required"
      fi
      ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) fail "unsupported CPU architecture: $ARCH" ;;
esac
case "$OS" in
  Darwin) PLATFORM=darwin APP_OS=mac ;;
  Linux) PLATFORM=linux APP_OS=linux ;;
  *) fail "unsupported operating system: $OS (on Windows use install.ps1)" ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/openems-gui-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

# ---- application --------------------------------------------------------------
if [ "$PLATFORM" = darwin ]; then
  ASSET="openEMS-GUI-mac-$ARCH.zip"
  if [ -n "${OPENEMS_GUI_APP_DIR:-}" ]; then
    APP_DIR="$OPENEMS_GUI_APP_DIR"
  elif [ -w /Applications ]; then
    APP_DIR=/Applications
  else
    APP_DIR="$HOME/Applications"
  fi
  DATA_DIR="${OPENEMS_GUI_DATA:-$HOME/Library/Application Support/openems-gui}"

  step "Downloading openEMS GUI ($VERSION, macOS $ARCH)"
  fetch "$APP_BASE/$ASSET" "$TMP/app.zip"
  step "Installing to $APP_DIR/openEMS GUI.app"
  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/openEMS GUI.app"
  ditto -x -k "$TMP/app.zip" "$APP_DIR"
  [ -d "$APP_DIR/openEMS GUI.app" ] || fail "the downloaded archive did not contain openEMS GUI.app"
  # not notarized: make sure Gatekeeper treats it like a locally built app
  xattr -dr com.apple.quarantine "$APP_DIR/openEMS GUI.app" 2>/dev/null || true
  LAUNCH="open -a \"$APP_DIR/openEMS GUI.app\""
else
  ASSET="openEMS-GUI-linux-$ARCH.tar.gz"
  APP_DIR="${OPENEMS_GUI_APP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openems-gui}"
  BIN_DIR="${OPENEMS_GUI_BIN_DIR:-$HOME/.local/bin}"
  DATA_DIR="${OPENEMS_GUI_DATA:-${XDG_CONFIG_HOME:-$HOME/.config}/openems-gui}"

  step "Downloading openEMS GUI ($VERSION, Linux $ARCH)"
  fetch "$APP_BASE/$ASSET" "$TMP/app.tar.gz"
  step "Installing to $APP_DIR"
  rm -rf "$APP_DIR/app"
  mkdir -p "$APP_DIR/app" "$BIN_DIR"
  tar -xzf "$TMP/app.tar.gz" -C "$APP_DIR/app" --strip-components 1
  [ -x "$APP_DIR/app/openems-gui" ] || fail "the downloaded archive did not contain the openems-gui executable"

  # Launcher. A per-user install cannot make Chromium's sandbox helper setuid root, so when the
  # kernel also forbids unprivileged user namespaces the sandbox is switched off. The app only
  # ever loads its own bundled pages from localhost.
  cat >"$BIN_DIR/openems-gui" <<EOF
#!/bin/sh
APP="$APP_DIR/app"
SANDBOX=""
if [ "\$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] ||
  [ "\$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then
  SANDBOX="--no-sandbox"
fi
exec "\$APP/openems-gui" \$SANDBOX "\$@"
EOF
  chmod +x "$BIN_DIR/openems-gui"

  DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$DESKTOP_DIR"
  cat >"$DESKTOP_DIR/openems-gui.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=openEMS GUI
Comment=Simulate Circuit JSON PCBs with openEMS
Exec=$BIN_DIR/openems-gui %f
Icon=$APP_DIR/app/resources/icon.png
Terminal=false
Categories=Science;Electronics;Engineering;
EOF
  LAUNCH="$BIN_DIR/openems-gui"
  case ":$PATH:" in
    *":$BIN_DIR:"*) LAUNCH="openems-gui" ;;
    *) PATH_NOTE="($BIN_DIR is not on your PATH)" ;;
  esac
fi

# ---- openEMS engine -------------------------------------------------------------
ENGINE_DIR="$DATA_DIR/openems-engine"
ENGINE_ASSET="openems-engine-$PLATFORM-$ARCH.tar.gz"
if [ "${OPENEMS_GUI_SKIP_ENGINE:-0}" = 1 ]; then
  say "Skipping the openEMS engine (OPENEMS_GUI_SKIP_ENGINE=1); the app will offer to download it."
elif [ -x "$ENGINE_DIR/bin/python3" ] && [ "$(cat "$ENGINE_DIR/RELEASE" 2>/dev/null)" = "$ENGINE_TAG" ]; then
  say "openEMS engine $ENGINE_TAG is already installed."
else
  step "Downloading the openEMS engine ($ENGINE_TAG)"
  if fetch "$ENGINE_BASE/$ENGINE_ASSET" "$TMP/engine.tar.gz"; then
    if fetch "$ENGINE_BASE/$ENGINE_ASSET.sha256" "$TMP/engine.sha256" 2>/dev/null; then
      EXPECTED="$(cut -d ' ' -f 1 "$TMP/engine.sha256")"
      [ "$(sha256_of "$TMP/engine.tar.gz")" = "$EXPECTED" ] || fail "the openEMS engine download is corrupt (checksum mismatch); please run the installer again"
    fi
    step "Unpacking the engine to $ENGINE_DIR"
    mkdir -p "$DATA_DIR" "$TMP/engine"
    tar -xzf "$TMP/engine.tar.gz" -C "$TMP/engine"
    [ -x "$TMP/engine/openems-engine/bin/python3" ] || fail "the engine archive is not valid"
    rm -rf "$ENGINE_DIR"
    mv "$TMP/engine/openems-engine" "$ENGINE_DIR"
    # remember which release this came from, so re-running the installer can skip the download
    printf '%s\n' "$ENGINE_TAG" >"$ENGINE_DIR/RELEASE"
    if "$ENGINE_DIR/bin/python3" -c "import openEMS, CSXCAD" >/dev/null 2>&1; then
      say "openEMS engine is ready."
    else
      say "warning: the downloaded engine does not start on this computer; the app will fall back to an installed openEMS or Docker."
    fi
  else
    say "warning: could not download a prebuilt engine for $PLATFORM-$ARCH. The app can use an openEMS you install yourself, or Docker."
  fi
fi

say ""
step "openEMS GUI is installed"
say "    Start it with:  $LAUNCH  ${PATH_NOTE:-}"
