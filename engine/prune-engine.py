#!/usr/bin/env python3
"""
Shrinks a freshly built engine prefix to what is needed at run time.

    prune-engine.py <prefix>           before the compilers are removed: drops shared
                                       libraries nothing in the engine links to
    prune-engine.py <prefix> --final   after: drops headers, docs, caches, static libs

Shared libraries are kept when they are reachable (through their link
dependencies) from the Python interpreter, any Python extension module, or
bin/openEMS and bin/nf2ff. conda-forge's VTK alone ships ~200 libraries; the
engine links a handful of them.
"""
import os
import re
import shutil
import subprocess
import sys

prefix = os.path.realpath(sys.argv[1])
final = "--final" in sys.argv
lib = os.path.join(prefix, "lib")
is_mac = sys.platform == "darwin"


def size_mb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            p = os.path.join(root, f)
            if not os.path.islink(p):
                total += os.path.getsize(p)
    return total / 1e6


def is_binary(path):
    try:
        with open(path, "rb") as fh:
            magic = fh.read(4)
    except OSError:
        return False
    return magic in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf")


def needed(path):
    """Base names of the shared libraries a binary links against."""
    names = []
    if is_mac:
        tool = shutil.which("otool") or shutil.which("llvm-otool") or "/usr/bin/otool"
        out = subprocess.run([tool, "-L", path], capture_output=True, text=True).stdout
        for line in out.splitlines()[1:]:
            m = re.match(r"\s+(\S+) \(", line)
            if m:
                names.append(os.path.basename(m.group(1)))
    else:
        tool = shutil.which("readelf") or next(
            (os.path.join(prefix, "bin", f) for f in sorted(os.listdir(os.path.join(prefix, "bin"))) if f.endswith("-readelf")), "readelf"
        )
        out = subprocess.run([tool, "-d", path], capture_output=True, text=True).stdout
        names += re.findall(r"\(NEEDED\)\s+Shared library: \[(.+?)\]", out)
    return names


def rm(path):
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
    elif os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


KEEP_SITE_PACKAGES = re.compile(r"(numpy|h5py|CSXCAD|openEMS|csxcad|openems)($|[-_.])", re.I)
# still needed by the build steps that follow the first pass
BUILD_SITE_PACKAGES = re.compile(r"(pip|setuptools|wheel|Cython|cython|pyximport|_distutils_hack|pkg_resources|packaging)($|[-_.])")


def python_dir():
    return next((os.path.join(lib, d) for d in sorted(os.listdir(lib)) if re.match(r"python3\.\d+$", d)), None)


def prune_site_packages(keep_build_tools):
    """conda-forge's VTK drags in matplotlib, Qt bindings and VTK's own Python wrappers; the engine imports none of them."""
    site = os.path.join(python_dir(), "site-packages")
    for d in os.listdir(site):
        if KEEP_SITE_PACKAGES.match(d) or (keep_build_tools and BUILD_SITE_PACKAGES.match(d)):
            continue
        if d in ("README.txt",):
            continue
        rm(os.path.join(site, d))


def strip_binaries():
    """Local symbols are a large share of the VTK libraries."""
    bindir = os.path.join(prefix, "bin")
    # macOS: Apple's strip (conda's llvm-strip rejects the linker-signed arm64 binaries)
    system_strip = "/usr/bin/strip" if is_mac and os.path.exists("/usr/bin/strip") else None
    tool = system_strip or shutil.which("strip") or next((os.path.join(bindir, f) for f in sorted(os.listdir(bindir)) if f.endswith("-strip")), None)
    if not tool:
        print("  no strip tool found; leaving symbols in place")
        return
    args = ["-x"] if is_mac else ["--strip-unneeded"]
    for root, _dirs, files in os.walk(prefix):
        for f in files:
            p = os.path.join(root, f)
            if not os.path.islink(p) and is_binary(p):
                # write a new file and swap it in: stripping in place would rewrite libraries
                # this very interpreter has mapped (a segfault on Linux)
                tmp = p + ".stripped"
                r = subprocess.run([tool, *args, "-o", tmp, p], capture_output=True)
                if r.returncode == 0 and os.path.exists(tmp):
                    shutil.copymode(p, tmp)
                    if is_mac:
                        # stripping invalidates the signature and arm64 macOS kills unsigned code
                        subprocess.run(["codesign", "--force", "--sign", "-", tmp], capture_output=True)
                    os.replace(tmp, p)
                elif os.path.exists(tmp):
                    os.remove(tmp)


def prune_libs():
    prune_site_packages(keep_build_tools=True)
    rm(os.path.join(lib, "vtk-9.7"))
    roots = []
    for name in ("python3", "openEMS", "nf2ff"):
        p = os.path.join(prefix, "bin", name)
        if os.path.exists(p):
            roots.append(os.path.realpath(p))
    # every extension module of the Python standard library and of the kept packages
    for root, _dirs, files in os.walk(python_dir()):
        for f in files:
            p = os.path.join(root, f)
            if (f.endswith(".so") or ".so." in f or f.endswith(".dylib")) and not os.path.islink(p):
                roots.append(p)
    # our own libraries are always roots
    for f in os.listdir(lib):
        if re.match(r"lib(CSXCAD|openEMS|nf2ff|fparser)", f):
            roots.append(os.path.realpath(os.path.join(lib, f)))

    keep = set()
    todo = list(dict.fromkeys(roots))
    while todo:
        path = todo.pop()
        if path in keep or not is_binary(path):
            continue
        keep.add(path)
        for name in needed(path):
            cand = os.path.join(lib, name)
            if os.path.exists(cand):
                real = os.path.realpath(cand)
                if real not in keep:
                    todo.append(real)

    removed = 0
    freed = 0
    for f in sorted(os.listdir(lib)):
        p = os.path.join(lib, f)
        if os.path.isdir(p) and not os.path.islink(p):
            continue
        if not (f.endswith(".dylib") or f.endswith(".so") or ".so." in f):
            continue
        real = os.path.realpath(p)
        if real in keep:
            continue
        if not os.path.islink(p):
            freed += os.path.getsize(p)
        os.remove(p)
        removed += 1
    print("  removed %d unused shared libraries (%.0f MB), kept %d binaries" % (removed, freed / 1e6, len(keep)))
    strip_binaries()


def prune_files():
    for rel in ("include", "share", "man", "doc", "docs", "etc", "ssl/man", "conda-meta", "lib/cmake", "lib/pkgconfig", "libexec", "sbin", "var", "mkspecs", "plugins", "translations", "phrasebooks", "qml"):
        rm(os.path.join(prefix, rel))
    pydir = python_dir()
    if pydir:
        for rel in ("test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "config-%s-darwin" % os.path.basename(pydir)[6:]):
            rm(os.path.join(pydir, rel))
        prune_site_packages(keep_build_tools=False)
    rm(os.path.join(prefix, "fonts"))
    for root, dirs, files in os.walk(prefix):
        for d in list(dirs):
            if d == "__pycache__" or (d == "tests" and "site-packages" in root):
                rm(os.path.join(root, d))
                dirs.remove(d)
        for f in files:
            if f.endswith((".a", ".pyc", ".la", ".h5.bak")):
                rm(os.path.join(root, f))
    # keep only the executables the engine uses
    bindir = os.path.join(prefix, "bin")
    for f in os.listdir(bindir):
        if not re.match(r"(python3?(\.\d+)?|openEMS|nf2ff)$", f):
            rm(os.path.join(bindir, f))
    # plugin / data directories of libraries the engine does not use (Qt, Tcl, OpenSSL engines, …)
    for d in os.listdir(lib):
        p = os.path.join(lib, d)
        if os.path.isdir(p) and not os.path.islink(p) and not re.match(r"python3\.\d+$", d):
            rm(p)
    # dangling symlinks left behind by the removals above
    for root, dirs, files in os.walk(prefix):
        for f in files + dirs:
            p = os.path.join(root, f)
            if os.path.islink(p) and not os.path.exists(p):
                os.remove(p)


before = size_mb(prefix)
if final:
    prune_files()
    if is_mac:
        # ad-hoc sign everything we built or touched; arm64 macOS refuses unsigned code
        for root, _dirs, files in os.walk(prefix):
            for f in files:
                p = os.path.join(root, f)
                if not os.path.islink(p) and is_binary(p):
                    subprocess.run(["codesign", "--force", "--sign", "-", p], capture_output=True)
else:
    prune_libs()
print("  %s: %.0f MB -> %.0f MB" % ("final" if final else "libs", before, size_mb(prefix)))
