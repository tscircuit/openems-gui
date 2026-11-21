import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ENGINE_PLATFORMS, ENGINE_RELEASE_TAG, ENGINE_REPO, engineAssetName } from "../server/engine-release"

const root = join(import.meta.dir, "..")
const read = (f: string) => readFileSync(join(root, f), "utf8")

test("install.sh downloads the engine release the app expects", () => {
  const sh = read("install.sh")
  expect(sh).toContain(`ENGINE_TAG="${ENGINE_RELEASE_TAG}"`)
  expect(sh).toContain(`REPO="${ENGINE_REPO}"`)
  // asset naming used by the script: openems-engine-$PLATFORM-$ARCH.tar.gz
  expect(sh).toContain('ENGINE_ASSET="openems-engine-$PLATFORM-$ARCH.tar.gz"')
  for (const p of ENGINE_PLATFORMS) expect(engineAssetName(p)).toBe(`openems-engine-${p}.tar.gz`)
  expect(engineAssetName("win32-x64")).toBeNull()
})

test("installer asset names match the electron-builder artifact names", () => {
  const pkg = JSON.parse(read("package.json"))
  expect(pkg.build.artifactName).toBe("openEMS-GUI-${os}-${arch}.${ext}")
  const sh = read("install.sh")
  expect(sh).toContain('ASSET="openEMS-GUI-mac-$ARCH.zip"')
  expect(sh).toContain('ASSET="openEMS-GUI-linux-$ARCH.tar.gz"')
  expect(read("install.ps1")).toContain('"openEMS-GUI-win-$arch-setup.exe"')
  expect(pkg.build.nsis.artifactName).toBe("openEMS-GUI-win-${arch}-setup.${ext}")
})

test("engine workflow builds every platform the app can download", () => {
  const yml = read(".github/workflows/engine.yml")
  for (const p of ENGINE_PLATFORMS) expect(yml).toContain(`platform: ${p},`)
})
