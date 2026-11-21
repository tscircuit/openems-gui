import { Circuit } from "tscircuit"
import { buildSimulation, defaultConfig } from "../src/lib/build-sim"
import { extractPcbModel } from "../src/lib/extract"

const circuit = new Circuit()
circuit.add(
  <board width="30mm" height="24mm" layers={4}>
    <pinheader name="J1" pinCount={4} pitch="2.54mm" pcbX={-10} pcbY={0} pcbRotation={90} />
    <chip name="U1" footprint="soic8" pcbX={2} pcbY={0} />
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={2} pcbY={7} />
    <resistor name="R2" resistance="0" footprint="0402" pcbX={8} pcbY={-7} pcbRotation={45} />
    <capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={-3} pcbY={-7} />
    <trace from=".J1 > .pin1" to=".U1 > .pin1" />
    <trace from=".J1 > .pin2" to=".R1 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin8" />
    <trace from=".J1 > .pin3" to=".C1 > .pin1" />
    <trace from=".C1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin4" to="net.GND" />
    <trace from=".J1 > .pin4" to="net.GND" />
    <trace from=".U1 > .pin5" to=".R2 > .pin1" />
    <copperpour layer="inner1" connectsTo="net.GND" />
    <copperpour layer="bottom" connectsTo="net.GND" />
  </board>,
)
await circuit.renderUntilSettled()
const json = circuit.getCircuitJson() as any[]
await Bun.write(import.meta.dir + "/../../robustness.circuit.json", JSON.stringify(json))
const m = extractPcbModel(json)
console.log("layers", m.layers, "pads", m.pads.length, "copper", m.copper.length, "barrels", m.barrels.length, "pours w/ holes", m.copper.filter((c) => c.holes?.length).map((c) => `${c.layer}:${c.holes!.length}`))
console.log("warnings", m.warnings, "passives", m.components.filter((c) => c.passive).map((c) => c.name + "=" + c.passive!.display))
const j1 = m.pads.find((p) => p.label === "J1.pin1")!
const cfg = { ...defaultConfig(m), meshRes: 0.25, ports: [{ id: "p", kind: "vertical" as const, name: "P1", x: j1.x, y: j1.y, layer: "top", refLayer: "inner1", impedance: 50, excite: true }] }
const b = buildSimulation(m, cfg)
console.log("errors", b.errors, "warnings", b.warnings, "stats", b.stats && { ...b.stats, region: undefined }, "lumped", b.lumped.map((l) => l.name), "vias", b.input?.vias.length)
if (b.input) {
  const { mkdirSync } = await import("node:fs")
  mkdirSync(import.meta.dir + "/../jobs/test-robust", { recursive: true })
  await Bun.write(import.meta.dir + "/../jobs/test-robust/sim.json", JSON.stringify({ ...b.input, max_timesteps: 3000 }))
}
