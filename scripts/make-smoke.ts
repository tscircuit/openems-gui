/** Regenerates engine/smoke/sim.json: a tiny job used to verify an engine build end to end. */
import { join } from "node:path"
import { buildSimulation, defaultConfig } from "../src/lib/build-sim"
import { extractPcbModel, normalizeCircuitJson } from "../src/lib/extract"

const json = normalizeCircuitJson(await Bun.file(join(import.meta.dir, "../examples/microstrip-line.circuit.json")).json())
const model = extractPcbModel(json)
const pad = (label: string) => model.pads.find((p) => p.label === label)!
const port = (n: number, label: string, excite: boolean) => ({
  id: `p${n}`,
  kind: "vertical" as const,
  name: `P${n}`,
  x: pad(label).x,
  y: pad(label).y,
  layer: "top",
  refLayer: "bottom",
  impedance: 50,
  excite,
})
const built = buildSimulation(model, {
  ...defaultConfig(model),
  fStartGHz: 1,
  fStopGHz: 4,
  freqPoints: 31,
  meshRes: 1,
  marginXY: 12,
  marginZ: 12,
  boundary: "PML_8",
  maxTimesteps: 4000,
  ports: [port(1, "P1.pin1", true), port(2, "P2.pin1", false)],
  nf2ff: { enabled: true, freqGHz: 2.4 },
})
if (!built.input) throw new Error(built.errors.join("; "))
await Bun.write(join(import.meta.dir, "../engine/smoke/sim.json"), JSON.stringify(built.input))
console.log("smoke job:", built.stats)
