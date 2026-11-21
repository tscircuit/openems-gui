#!/usr/bin/env bash
#
# Builds a self-contained, relocatable openEMS engine for the current platform:
#
#   openems-engine/
#     bin/python3            Python with numpy, h5py, CSXCAD and openEMS modules
#     bin/openEMS, bin/nf2ff
#     lib/                   every shared library the above need
#     ENGINE.json            versions + platform
#
# Dependencies (VTK, HDF5, Boost, CGAL, TinyXML, compilers) come from conda-forge
# through micromamba, into a private prefix, so nothing is installed system-wide
# and the same recipe works on macOS (arm64 / x64) and Linux (x64 / arm64).
#
#   engine/build-engine.sh            # -> dist-engine/openems-engine-<platform>.tar.gz
#
# Environment: OPENEMS_VERSION (git tag of thliebig/openEMS-Project), WORK, OUT.
set -euo pipefail

OPENEMS_VERSION="${OPENEMS_VERSION:-v0.37.0}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$PWD/.engine-build}"
OUT="${OUT:-$PWD/dist-engine}"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin-arm64; MAMBA_PLATFORM=osx-arm64 ;;
  Darwin-x86_64) PLATFORM=darwin-x64; MAMBA_PLATFORM=osx-64 ;;
  Linux-x86_64) PLATFORM=linux-x64; MAMBA_PLATFORM=linux-64 ;;
  Linux-aarch64) PLATFORM=linux-arm64; MAMBA_PLATFORM=linux-aarch64 ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$WORK" "$OUT"
cd "$WORK"
ENGINE="$WORK/openems-engine"
export MAMBA_ROOT_PREFIX="$WORK/mamba-root"

log() { printf '\n==> %s\n' "$*"; }

# ---- micromamba + dependencies ----------------------------------------------
if [ ! -x "$WORK/bin/micromamba" ]; then
  log "Downloading micromamba ($MAMBA_PLATFORM)"
  curl -fsSL "https://micro.mamba.pm/api/micromamba/$MAMBA_PLATFORM/latest" | tar -xj bin/micromamba
fi
MAMBA="$WORK/bin/micromamba"

# Packages that stay in the shipped engine
RUNTIME_PKGS=("python=$PYTHON_VERSION" numpy h5py hdf5 vtk-base tinyxml libboost gmp mpfr)
# Packages only needed to compile; removed again before packing
# (vtk-io-ffmpeg only because conda-forge's VTK CMake config refuses to load without it)
BUILD_PKGS=(cxx-compiler c-compiler cmake make pkg-config libboost-devel cgal-cpp cython setuptools pip wheel patchelf vtk-io-ffmpeg tbb-devel)
if [ "$(uname -s)" = Darwin ]; then BUILD_PKGS=("${BUILD_PKGS[@]/patchelf/}"); fi

log "Installing dependencies from conda-forge"
if [ ! -d "$ENGINE/conda-meta" ]; then
  "$MAMBA" create -y -q -p "$ENGINE" -c conda-forge "python=$PYTHON_VERSION"
fi
# shellcheck disable=SC2068
"$MAMBA" install -y -q -p "$ENGINE" -c conda-forge ${RUNTIME_PKGS[@]} ${BUILD_PKGS[@]}

set +u
eval "$("$MAMBA" shell hook -s bash)"
micromamba activate "$ENGINE"
set -u

# ---- sources ------------------------------------------------------------------
SRC="$WORK/openEMS-Project"
if [ ! -d "$SRC/.git" ]; then
  log "Cloning openEMS-Project $OPENEMS_VERSION"
  git clone -q --depth 1 --branch "$OPENEMS_VERSION" --recursive --shallow-submodules \
    https://github.com/thliebig/openEMS-Project.git "$SRC"
fi

if [ "$(uname -s)" = Darwin ]; then
  RPATH_LIB='@loader_path/../lib'
  RPATH_PYEXT='@loader_path/../../..'
else
  RPATH_LIB='$ORIGIN/../lib'
  RPATH_PYEXT='$ORIGIN/../../..'
fi

cmake_build() { # <name> <source dir> [extra cmake args...]
  local name="$1" src="$2"
  shift 2
  log "Building $name"
  cmake -S "$src" -B "$WORK/build/$name" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$ENGINE" \
    -DCMAKE_PREFIX_PATH="$ENGINE" \
    -DCMAKE_INSTALL_RPATH="$RPATH_LIB" \
    -DCMAKE_INSTALL_NAME_DIR=@rpath \
    -DCMAKE_MACOSX_RPATH=ON \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    "$@" >"$WORK/build-$name.log" 2>&1 || { tail -40 "$WORK/build-$name.log"; exit 1; }
  cmake --build "$WORK/build/$name" -j "$JOBS" >>"$WORK/build-$name.log" 2>&1 || { tail -60 "$WORK/build-$name.log"; exit 1; }
  cmake --install "$WORK/build/$name" >>"$WORK/build-$name.log" 2>&1 || { tail -40 "$WORK/build-$name.log"; exit 1; }
}

cmake_build fparser "$SRC/fparser"
cmake_build CSXCAD "$SRC/CSXCAD" -DFPARSER_ROOT_DIR="$ENGINE"
cmake_build openEMS "$SRC/openEMS" -DFPARSER_ROOT_DIR="$ENGINE" -DCSXCAD_ROOT_DIR="$ENGINE" -DWITH_MPI=OFF

log "Building Python modules"
export CSXCAD_INSTALL_PATH="$ENGINE" OPENEMS_INSTALL_PATH="$ENGINE"
export CSXCAD_NOSCM=1 OPENEMS_NOSCM=1
export LDFLAGS="${LDFLAGS:-} -Wl,-rpath,$RPATH_PYEXT"
(cd "$SRC/CSXCAD/python" && python -m pip install --no-deps --no-build-isolation . >"$WORK/build-py-csxcad.log" 2>&1) || { tail -60 "$WORK/build-py-csxcad.log"; exit 1; }
(cd "$SRC/openEMS/python" && python -m pip install --no-deps --no-build-isolation . >"$WORK/build-py-openems.log" 2>&1) || { tail -60 "$WORK/build-py-openems.log"; exit 1; }

# ---- slim down ------------------------------------------------------------------
log "Pruning"
OPENEMS_COMMIT="$(git -C "$SRC" rev-parse --short HEAD)"
python "$HERE/prune-engine.py" "$ENGINE"
micromamba deactivate || true
# shellcheck disable=SC2068
"$MAMBA" remove -y -q -p "$ENGINE" ${BUILD_PKGS[@]} >/dev/null 2>&1 || true
"$ENGINE/bin/python3" "$HERE/prune-engine.py" "$ENGINE" --final

cat >"$ENGINE/ENGINE.json" <<EOF
{ "openems": "$OPENEMS_VERSION", "commit": "$OPENEMS_COMMIT", "platform": "$PLATFORM", "python": "$PYTHON_VERSION", "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

cat >"$ENGINE/NOTICE.txt" <<EOF
openEMS engine bundle for openEMS GUI (https://github.com/tscircuit/openems-gui)

Built from unmodified upstream sources by engine/build-engine.sh:

  openEMS   $OPENEMS_VERSION ($OPENEMS_COMMIT)   GPL-3.0-or-later    https://github.com/thliebig/openEMS
  CSXCAD                        LGPL-3.0-or-later   https://github.com/thliebig/CSXCAD
  fparser                       LGPL-3.0            https://github.com/thliebig/fparser
  (all three via https://github.com/thliebig/openEMS-Project at tag $OPENEMS_VERSION)

Python, NumPy, h5py, HDF5, VTK, Boost, TinyXML, GMP, MPFR and their dependencies are
unmodified conda-forge packages (https://conda-forge.org), each under its own licence.
EOF

# ---- verify it still works after being moved, then pack ----------------------------
log "Smoke test (relocated copy)"
RELOC="$WORK/relocated/engine with space"
rm -rf "$WORK/relocated" "$WORK/smoke"
mkdir -p "$WORK/relocated" "$WORK/smoke"
cp -a "$ENGINE" "$RELOC"
cp "$HERE/smoke/sim.json" "$WORK/smoke/sim.json"
env -i HOME="$HOME" PATH=/usr/bin:/bin "$RELOC/bin/python3" "$HERE/run_sim.py" "$WORK/smoke" >"$WORK/smoke/log.txt" 2>&1 || { tail -60 "$WORK/smoke/log.txt"; exit 1; }
"$RELOC/bin/python3" "$HERE/smoke/check.py" "$WORK/smoke/results.json"
rm -rf "$WORK/relocated"

log "Packing"
TARBALL="$OUT/openems-engine-$PLATFORM.tar.gz"
tar -C "$WORK" -czf "$TARBALL" openems-engine
if command -v shasum >/dev/null 2>&1; then (cd "$OUT" && shasum -a 256 "$(basename "$TARBALL")" >"$(basename "$TARBALL").sha256"); else (cd "$OUT" && sha256sum "$(basename "$TARBALL")" >"$(basename "$TARBALL").sha256"); fi
du -sh "$ENGINE" "$TARBALL"
log "Done: $TARBALL"
