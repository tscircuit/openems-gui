import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AppConfig } from "./config"

/** Paths when running from a source checkout (development and `bun run start`). */
export const repoConfig = (): AppConfig => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  return {
    dataDir: process.env.OPENEMS_GUI_DATA ?? root,
    engineDir: join(root, "engine"),
    examplesDir: join(root, "examples"),
    uiDir: join(root, "dist", "ui"),
  }
}
