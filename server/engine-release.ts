/**
 * Where prebuilt engine bundles are published. They are built by
 * .github/workflows/engine.yml and attached to a GitHub release with this tag.
 * install.sh carries the same tag; tests/release.test.ts keeps the two in sync.
 */
export const ENGINE_REPO = "tscircuit/openems-gui"
export const ENGINE_RELEASE_TAG = "engine-v0.37.0-1"

/** Platforms that have a prebuilt engine (process.platform-process.arch). */
export const ENGINE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const

export const engineAssetName = (platform: string): string | null =>
  (ENGINE_PLATFORMS as readonly string[]).includes(platform) ? `openems-engine-${platform}.tar.gz` : null
