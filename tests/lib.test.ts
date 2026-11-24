import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { buildSimulation, defaultConfig, lateralGeom } from "../src/lib/build-sim"
import { EXAMPLES } from "../src/lib/examples"
import { extractPcbModel, normalizeCircuitJson, parseValue } from "../src/lib/extract"
import { clipPolygonToRect, decomposeWithHoles, pointInPolygon, polygonArea, rectPoly, stadiumPoly } from "../src/lib/geom"
import { fillMesh, mergeLines } from "../src/lib/mesh"

const load = async (file: string) => extractPcbModel(normalizeCircuitJson(await Bun.file(join(import.meta.dir, "../examples", file)).json()))

describe("geometry", () => {
  test("stadium area = rectangle + circle", () => {
    const a = polygonArea(stadiumPoly({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 32))
    expect(a).toBeCloseTo(10 * 2 + Math.PI, 1)
  })
  test("holes are removed by trapezoid decomposition", () => {
    const outer = rectPoly(0, 0, 10, 10)
    const hole = rectPoly(1, 1, 2, 4, 30)
    const parts = decomposeWithHoles(outer, [hole])
    expect(parts.reduce((s, p) => s + polygonArea(p), 0)).toBeCloseTo(100 - 8, 6)
  })
  test("clip to rectangle", () => {
    const c = clipPolygonToRect(rectPoly(0, 0, 10, 2), { minX: -1, maxX: 1, minY: -5, maxY: 5 })
    expect(polygonArea(c)).toBeCloseTo(4, 9)
  })
  test("points on every polygon boundary count as inside", () => {
    const poly = rectPoly(0, 0, 10, 10)
    for (const p of [
      { x: 0, y: -5 },
      { x: 5, y: 0 },
      { x: 0, y: 5 },
      { x: -5, y: 0 },
      { x: 5, y: 5 },
    ])
      expect(pointInPolygon(p, poly)).toBe(true)
  })
})

describe("mesh", () => {
  test("merge keeps hard constraints and drops near-duplicates", () => {
    const lines = mergeLines(
      [
        { pos: 0, priority: 1 },
        { pos: 0.05, priority: 3 },
        { pos: 0.1, priority: 1 },
        { pos: 0.12, priority: 3 },
        { pos: 1, priority: 1 },
      ],
      0.2,
    )
    expect(lines).toEqual([0.05, 0.12, 1])
  })
  test("fill respects max cell and grading", () => {
    const lines = fillMesh([-20, 0, 0.2, 0.4, 20], (x) => (x < 0 || x > 0.4 ? 3 : 0.2), 1.4)
    expect(lines[0]).toBe(-20)
    expect(lines[lines.length - 1]).toBe(20)
    for (let i = 0; i + 1 < lines.length; i++) expect(lines[i + 1] - lines[i]).toBeLessThanOrEqual(3 + 1e-9)
    for (let i = 0; i + 2 < lines.length; i++) {
      const a = lines[i + 1] - lines[i]
      const b = lines[i + 2] - lines[i + 1]
      expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(1.45)
    }
  })
})

describe("circuit json", () => {
  test("parses SI-suffixed strings", () => {
    expect(parseValue("8.2nH")).toBeCloseTo(8.2e-9, 15)
    expect(parseValue("4.7k")).toBe(4700)
    expect(parseValue(3.3e-12)).toBe(3.3e-12)
  })
  test("microstrip example", async () => {
    const m = await load("microstrip-line.circuit.json")
    expect(m.layers).toEqual(["top", "bottom"])
    expect(m.board.thickness).toBe(1.6)
    expect(m.pads.map((p) => p.label).sort()).toEqual(["P1.pin1", "P2.pin1"])
    expect(m.copper.filter((c) => c.kind === "pour" && c.layer === "bottom")).toHaveLength(1)
    expect(m.copper.filter((c) => c.kind === "trace")).toHaveLength(1)
  })
  test("lc example finds passives and vias", async () => {
    const m = await load("lc-lowpass.circuit.json")
    expect(m.components.filter((c) => c.passive).map((c) => `${c.name}=${c.passive!.display}`).sort()).toEqual(["C1=3.3pF", "C2=3.3pF", "L1=8.2nH"])
    expect(m.barrels).toHaveLength(2)
    const [a, b] = m.components.find((c) => c.name === "L1")!.padIds.map((id) => m.pads.find((p) => p.id === id)!)
    const g = lateralGeom(a, b)
    expect("direction" in g && g.direction).toBe("x")
  })
  test("ifa example: keep-out, stitched ground and a gap port at the feed", async () => {
    const m = await load("wifi-ifa.circuit.json")
    expect(m.warnings).toEqual([])
    const pours = m.copper.filter((c) => c.kind === "pour")
    expect(pours.map((c) => c.layer).sort()).toEqual(["bottom", "top"])
    // no ground copper under the antenna: the pours stop well below the top board edge
    for (const c of pours) expect(c.bbox.maxY).toBeLessThan(m.board.maxY - 5)
    expect(m.barrels.length).toBeGreaterThan(20)
    const ex = EXAMPLES.find((e) => e.id === "wifi-ifa")!
    const built = buildSimulation(m, ex.configure(defaultConfig(m), m))
    expect(built.warnings).toEqual([])
    const [port] = built.ports
    expect(port.direction).toBe("y")
    expect(Math.abs(port.stop[1] - port.start[1])).toBeCloseTo(0.5, 6)
    expect(port.start[2]).toBe(m.board.thickness)
  })
  test("wilkinson example: the 100 ohm resistor becomes a lumped element", async () => {
    const m = await load("wilkinson-divider.circuit.json")
    expect(m.warnings).toEqual([])
    expect(m.components.filter((c) => c.passive).map((c) => `${c.name}=${c.passive!.display}`)).toEqual(["R1=100Ω"])
    const ex = EXAMPLES.find((e) => e.id === "wilkinson-divider")!
    const built = buildSimulation(m, ex.configure(defaultConfig(m), m))
    expect(built.warnings).toEqual([])
    expect(built.lumped.map((l) => [l.kind, l.value, l.direction])).toEqual([["R", 100, "y"]])
    expect(built.ports.filter((p) => p.excite).map((p) => p.number)).toEqual([1, 2])
  })
  test("rejects non circuit json", () => {
    expect(() => normalizeCircuitJson({ hello: 1 })).toThrow()
    expect(() => extractPcbModel([{ type: "source_component" }])).toThrow()
  })
})

describe("simulation build", () => {
  for (const ex of EXAMPLES)
    test(`${ex.id} builds a valid job`, async () => {
      const m = await load(ex.file)
      const built = buildSimulation(m, ex.configure(defaultConfig(m), m))
      expect(built.errors).toEqual([])
      const sim = built.input!
      for (const axis of ["x", "y", "z"] as const) {
        const l = sim.mesh[axis]
        for (let i = 0; i + 1 < l.length; i++) expect(l[i + 1]).toBeGreaterThan(l[i])
      }
      // every port end sits exactly on mesh lines
      for (const p of sim.ports)
        for (const pt of [p.start, p.stop]) {
          expect(sim.mesh.x).toContain(+pt[0].toFixed(6))
          expect(sim.mesh.y).toContain(+pt[1].toFixed(6))
          expect(sim.mesh.z).toContain(+pt[2].toFixed(6))
        }
      for (const v of sim.vias) {
        expect(sim.mesh.x).toContain(v.x)
        expect(sim.mesh.y).toContain(v.y)
      }
      expect(built.stats!.cells).toBeLessThan(2e6)
    })
  test("needs a port and reports missing reference copper", async () => {
    const m = await load("patch-antenna.circuit.json")
    const cfg = defaultConfig(m)
    expect(buildSimulation(m, cfg).errors.join(" ")).toContain("Add at least one port")
    const withPort = buildSimulation(m, { ...cfg, ports: [{ id: "a", kind: "vertical", name: "A", x: 25, y: 25, layer: "top", refLayer: "bottom", impedance: 50, excite: true }] })
    expect(withPort.warnings.join(" ")).toContain('no copper on "top"')
  })
  test("region crop clips copper and drops outside ports", async () => {
    const m = await load("microstrip-line.circuit.json")
    const ex = EXAMPLES.find((e) => e.id === "microstrip-line")!
    const cfg = { ...ex.configure(defaultConfig(m), m), region: { minX: -20, maxX: 0, minY: -10, maxY: 10 } }
    const built = buildSimulation(m, cfg)
    expect(built.errors.join(" ")).toContain("outside the simulation region")
    const one = buildSimulation(m, { ...cfg, ports: cfg.ports.slice(0, 1) })
    expect(one.errors).toEqual([])
    expect(Math.max(...one.input!.polygons.flatMap((p) => p.points.map((q) => q[0])))).toBeLessThanOrEqual(0)
  })
})
