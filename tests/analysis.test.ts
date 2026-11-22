import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { buildSimulation, defaultConfig, meshKey } from "../src/lib/build-sim"
import { EXAMPLES } from "../src/lib/examples"
import { extractPcbModel, normalizeCircuitJson } from "../src/lib/extract"
import { fft, groupDelayPs, minRiseTimePs, phaseDelayPs, riseTime1090Ps, stepDelayPs, stepResponse, tdrImpedance } from "../src/lib/timedomain"

const load = async (file: string) => extractPcbModel(normalizeCircuitJson(await Bun.file(join(import.meta.dir, "../examples", file)).json()))

/** The grid run_sim.py produces: linspace(max(f_start, 1 Hz), f_stop, n). */
const grid = (fStart: number, fStop: number, n: number) => Array.from({ length: n }, (_, k) => Math.max(fStart, 1) + ((fStop - Math.max(fStart, 1)) * k) / (n - 1))
const delayLine = (freq: number[], tau: number, gain = 1) => ({
  freq,
  re: freq.map((f) => gain * Math.cos(-2 * Math.PI * f * tau)),
  im: freq.map((f) => gain * Math.sin(-2 * Math.PI * f * tau)),
})

describe("time domain", () => {
  test("fft round trip", () => {
    const re = new Float64Array([1, 2, 3, 4, 0, -1, 5, 2])
    const im = new Float64Array(8)
    const orig = [...re]
    fft(re, im)
    fft(re, im, true)
    for (let i = 0; i < 8; i++) expect(re[i] / 8).toBeCloseTo(orig[i], 12)
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow()
  })

  test("an ideal delay line gives its delay, gain and the input rise time", () => {
    const s = delayLine(grid(0, 10e9, 401), 200e-12, 0.9)
    const r = stepResponse(s, { tMaxPs: 1000 })
    expect(r.riseTimePs).toBeCloseTo(minRiseTimePs(10e9), 3)
    expect(stepDelayPs(r)!).toBeCloseTo(200, 0)
    expect(r.final).toBeCloseTo(0.9, 2)
    expect(r.v[r.v.length - 1]).toBeCloseTo(0.9, 2)
    expect(riseTime1090Ps(r)!).toBeCloseTo(r.riseTimePs, 0)
    expect(groupDelayPs(s)[200]).toBeCloseTo(200, 3)
    expect(phaseDelayPs(s)[200]).toBeCloseTo(200, 3)
  })

  test("skew between two lines is resolved to a fraction of a picosecond", () => {
    const freq = grid(0, 10e9, 401)
    const a = stepDelayPs(stepResponse(delayLine(freq, 180e-12)))!
    const b = stepDelayPs(stepResponse(delayLine(freq, 187.5e-12)))!
    expect(b - a).toBeCloseTo(7.5, 1)
  })

  test("a band that does not start at DC is extrapolated", () => {
    const r = stepResponse(delayLine(grid(0.2e9, 6e9, 401), 150e-12))
    expect(stepDelayPs(r)!).toBeCloseTo(150, 0)
  })

  test("TDR shows a 60 Ω section in a 50 Ω line", () => {
    const freq = grid(0, 10e9, 401)
    const rho = (60 - 50) / (60 + 50)
    // reflection step up at 100 ps (round trip) and back down at 300 ps
    const s11 = {
      freq,
      re: freq.map((f) => rho * (Math.cos(2 * Math.PI * f * 100e-12) - Math.cos(2 * Math.PI * f * 300e-12))),
      im: freq.map((f) => -rho * (Math.sin(2 * Math.PI * f * 100e-12) - Math.sin(2 * Math.PI * f * 300e-12))),
    }
    const z = tdrImpedance(s11, 50, { tMaxPs: 600 })
    const at = (ps: number) => z.z[z.t.findIndex((t) => t >= ps)]
    expect(at(0)).toBeCloseTo(50, 0)
    expect(at(200)).toBeCloseTo(60, 0)
    expect(at(450)).toBeCloseTo(50, 0)
  })
})

describe("field recordings and previews", () => {
  test("no recordings unless asked for", async () => {
    const model = await load("microstrip-line.circuit.json")
    const ex = EXAMPLES.find((e) => e.id === "microstrip-line")!
    const built = buildSimulation(model, ex.configure(defaultConfig(model), model))
    expect(built.input!.dumps).toEqual([])
    expect(built.stats!.dumpPoints).toEqual({ volume: 0, plane: 0 })
  })

  test("frequency and time recordings are boxes inside the simulation domain, capped in size", async () => {
    const model = await load("microstrip-line.circuit.json")
    const ex = EXAMPLES.find((e) => e.id === "microstrip-line")!
    const base = ex.configure(defaultConfig(model), model)
    const built = buildSimulation(model, { ...base, meshRes: 0.1, fields: { frequency: true, freqsGHz: [1, 3, 99], time: true, height: 2 } })
    const sim = built.input!
    expect(sim.dumps.map((d) => `${d.name}:${d.quantity}:${d.domain}`)).toEqual(["E:E:freq", "H:H:freq", "Et:E:time"])
    expect(sim.dumps[0].freqs).toEqual([1e9, 3e9])
    expect(built.warnings.join(" ")).toContain("above the stop frequency")
    for (const d of sim.dumps) {
      for (const [k, axis] of (["x", "y", "z"] as const).entries()) {
        expect(d.start[k]).toBeGreaterThanOrEqual(sim.mesh[axis][0])
        expect(d.stop[k]).toBeLessThanOrEqual(sim.mesh[axis][sim.mesh[axis].length - 1])
      }
    }
    // the fine mesh has far more points than the caps, so both recordings are sub-sampled
    expect(sim.dumps[0].sub[0]).toBeGreaterThan(1)
    expect(built.stats!.dumpPoints.volume).toBeLessThanOrEqual(260e3)
    expect(built.stats!.dumpPoints.plane).toBeLessThanOrEqual(31e3)
    // the movie plane lies inside the substrate
    const et = sim.dumps[2]
    expect(et.start[2]).toBe(et.stop[2])
    expect(et.start[2]).toBeGreaterThan(0)
    expect(et.start[2]).toBeLessThan(base.thickness)
    // an empty frequency list means the band centre
    const centre = buildSimulation(model, { ...base, fields: { frequency: true, freqsGHz: [], time: false, height: 2 } })
    expect(centre.input!.dumps[0].freqs).toEqual([((base.fStartGHz + base.fStopGHz) / 2) * 1e9])
  })

  test("the geometry and mesh are available for previews before any port exists", async () => {
    const model = await load("microstrip-line.circuit.json")
    const built = buildSimulation(model, defaultConfig(model))
    expect(built.input).toBeNull()
    expect(built.errors.join(" ")).toContain("Add at least one port")
    expect(built.preview!.polygons.length).toBeGreaterThan(0)
    expect(built.stats!.cells).toBeGreaterThan(1000)
  })

  test("meshKey follows the grid, not the solver settings", async () => {
    const model = await load("microstrip-line.circuit.json")
    const ex = EXAMPLES.find((e) => e.id === "microstrip-line")!
    const base = ex.configure(defaultConfig(model), model)
    const key = (c: typeof base) => meshKey(buildSimulation(model, c).preview!)
    expect(key({ ...base, maxTimesteps: 123, threads: 2, fields: { frequency: true, freqsGHz: [], time: false, height: 1 } })).toBe(key(base))
    expect(key({ ...base, meshRes: base.meshRes / 2 })).not.toBe(key(base))
    expect(key({ ...base, marginZ: base.marginZ + 1 })).not.toBe(key(base))
  })
})
