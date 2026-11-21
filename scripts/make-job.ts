/**
 * Headless helper: build a job directory from a bundled example.
 *   bun scripts/make-job.ts <example-id> <job-dir>
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildSimulation, defaultConfig } from "../src/lib/build-sim"
import { EXAMPLES } from "../src/lib/examples"
import { extractPcbModel, normalizeCircuitJson } from "../src/lib/extract"

const [id, dir] = process.argv.slice(2)
const ex = EXAMPLES.find((e) => e.id === id)
if (!ex || !dir) throw new Error(`usage: make-job.ts <${EXAMPLES.map((e) => e.id).join("|")}> <job-dir>`)
const json = normalizeCircuitJson(await Bun.file(join(import.meta.dir, "../examples", ex.file)).json())
const model = extractPcbModel(json)
const config = ex.configure(defaultConfig(model), model)
const built = buildSimulation(model, config)
console.log("model warnings:", model.warnings)
console.log("errors:", built.errors, "warnings:", built.warnings)
console.log("stats:", built.stats)
console.log("ports:", JSON.stringify(built.ports), "lumped:", JSON.stringify(built.lumped))
if (!built.input) process.exit(1)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, "sim.json"), JSON.stringify(built.input))
