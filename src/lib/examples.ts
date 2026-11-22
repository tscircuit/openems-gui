import type { PcbModel, SimConfig } from "./types"

export interface ExampleDef {
  id: string
  title: string
  description: string
  file: string
  /** Tweaks applied on top of defaultConfig(model) */
  configure: (config: SimConfig, model: PcbModel) => SimConfig
}

const padPort = (model: PcbModel, label: string, n: number, excite: boolean) => {
  const pad = model.pads.find((p) => p.label === label)
  if (!pad) throw new Error(`example pad ${label} not found`)
  return {
    id: `port${n}`,
    kind: "vertical" as const,
    name: `P${n} (${label})`,
    x: pad.x,
    y: pad.y,
    layer: "top",
    refLayer: "bottom",
    impedance: 50,
    excite,
    padId: pad.id,
  }
}

/** Lumped port across the gap between the two facing pads labelled `labelA` and `labelB`. */
const gapPort = (model: PcbModel, labelA: string, labelB: string, n: number, name: string, excite: boolean) => {
  const a = model.pads.find((p) => p.label === labelA)
  const b = model.pads.find((p) => p.label === labelB)
  if (!a || !b) throw new Error(`example pads ${labelA} / ${labelB} not found`)
  return { id: `port${n}`, kind: "lateral" as const, name, padA: a.id, padB: b.id, impedance: 50, excite }
}

/**
 * The two DDR boards differ only in the gap between the serpentine legs. Both route DQ0 2 mm longer than DQS
 * to make up for its twelve square corners (each is electrically about 0.17 mm shorter than its centre line),
 * so that the well spaced serpentine really is matched. Open the Time domain results for delay, skew and TDR,
 * and 3D fields for the pulse travelling down both nets.
 *
 * Shared set-up of the two DDR serpentine boards: DC to 10 GHz on a 0.1 mm mesh (all copper edges are on that
 * grid), ports 1-2 on the straight DQS trace and 3-4 on the length-matched DQ0 trace. Ports 1 and 3 are
 * excited, which gives the through delay and TDR of both nets and the crosstalk between them.
 */
const ddrConfig = (c: SimConfig, m: PcbModel): SimConfig => ({
  ...c,
  fStartGHz: 0,
  fStopGHz: 10,
  // L1 over the L2 plane of a 4-layer board; the circuit JSON carries the 0.2 mm thickness
  thickness: 0.2,
  meshRes: 0.1,
  substrateCells: 4,
  boundary: "MUR",
  marginXY: 3,
  marginZ: 3,
  // 2.5 ns. With a pulse that reaches down to DC the field energy levels off near -24 dB, so the -40 dB end
  // criterion never triggers; the port signals are over long before (|ΔS| < 1e-4 against 60000 steps).
  maxTimesteps: 20000,
  // The solver's dielectric loss is a constant conductivity fitted at the band centre. Over a band that
  // starts at DC that acts like a leaky dielectric (DC gain 0.95, sagging TDR), so the loss is left out here;
  // it changes the skew by less than 0.3 ps.
  tanD: 0,
  ports: [
    { ...padPort(m, "P1.pin1", 1, true), name: "DQS in" },
    { ...padPort(m, "P2.pin1", 2, false), name: "DQS out" },
    { ...padPort(m, "P3.pin1", 3, true), name: "DQ0 in" },
    { ...padPort(m, "P4.pin1", 4, false), name: "DQ0 out" },
  ],
  // record the pulse travelling along both nets, and the fields at 2 GHz, for the 3D view
  fields: { frequency: true, freqsGHz: [2], time: true, height: 1 },
})

export const EXAMPLES: ExampleDef[] = [
  {
    id: "ddr-bad",
    title: "Bad DDR: tight serpentine",
    description:
      "DQ0 is length-matched to a straight 26 mm DQS strobe with a serpentine whose legs are only 0.2 mm apart (half a trace width). The legs couple, so the edge takes a shortcut: simulated, DQ0 arrives 13 ps before DQS and its TDR dips to 37 Ω.",
    file: "bad-ddr.circuit.json",
    configure: ddrConfig,
  },
  {
    id: "ddr-good",
    title: "Good DDR: spaced serpentine",
    description:
      "The same board, pads, routed length and corners, with the serpentine legs 1.2 mm apart (3 trace widths): simulated, DQ0 arrives within 1.2 ps of DQS and its TDR stays within 2 Ω.",
    file: "good-ddr.circuit.json",
    configure: ddrConfig,
  },
  {
    id: "wifi-ifa",
    title: "2.4 GHz Wi-Fi / BLE inverted-F antenna",
    description:
      "Printed IFA on a 25 × 45 mm FR-4 module board, 7 mm keep-out: simulated |S11| ≤ −19 dB over 2.40–2.4835 GHz, 2.8 dBi, 95 % efficiency.",
    file: "wifi-ifa.circuit.json",
    configure: (c, m) => ({
      ...c,
      fStartGHz: 1.5,
      fStopGHz: 3.5,
      meshRes: 0.5,
      boundary: "PML_8",
      marginXY: 30,
      marginZ: 30,
      maxTimesteps: 40000,
      // lossy copper, so the radiation efficiency includes conductor as well as FR-4 loss
      copperModel: "sheet",
      // feed stub (pin1) against the ground edge (pin2), across the 0.5 mm feed gap
      ports: [gapPort(m, "ANT1.pin1", "ANT1.pin2", 1, "Feed", true)],
      nf2ff: { enabled: true, freqGHz: 2.44 },
      // near fields around the board at the Wi-Fi band centre, for the 3D view
      fields: { frequency: true, freqsGHz: [2.44], time: false, height: 5 },
    }),
  },
  {
    id: "hairpin-bpf",
    title: "2.4 GHz hairpin band-pass filter",
    description:
      "3-pole hairpin filter on FR-4: simulated 2.30–2.55 GHz passband, 2.5–3.4 dB loss, ≥ 17 dB return loss, 31 / 24 dB rejection at 1.5 / 3.5 GHz.",
    file: "hairpin-bpf.circuit.json",
    configure: (c, m) => ({
      ...c,
      fStartGHz: 1,
      fStopGHz: 4,
      meshRes: 0.25,
      boundary: "MUR",
      marginXY: 6,
      marginZ: 8,
      maxTimesteps: 40000,
      // lossy copper: the insertion loss is the number of interest here
      copperModel: "sheet",
      ports: [padPort(m, "P1.pin1", 1, true), padPort(m, "P2.pin1", 2, false)],
    }),
  },
  {
    id: "wilkinson-divider",
    title: "2.4 GHz Wilkinson power divider",
    description:
      "Quarter-wave arms and a 100 Ω 0603 resistor on FR-4: simulated S21 = S31 = −3.5 dB, S11 = −18.6 dB, isolation S32 = −28 dB at 2.4 GHz.",
    file: "wilkinson-divider.circuit.json",
    configure: (c, m) => ({
      ...c,
      fStartGHz: 1,
      fStopGHz: 4,
      meshRes: 0.25,
      boundary: "MUR",
      marginXY: 6,
      marginZ: 8,
      maxTimesteps: 40000,
      copperModel: "sheet",
      // port 2 is excited as well so that the output isolation S32 is computed
      ports: [padPort(m, "P1.pin1", 1, true), padPort(m, "P2.pin1", 2, true), padPort(m, "P3.pin1", 3, false)],
    }),
  },
  {
    id: "microstrip-line",
    title: "50 Ω microstrip line",
    description: "3 mm trace over a ground pour on 1.6 mm FR-4, two ports.",
    file: "microstrip-line.circuit.json",
    configure: (c, m) => ({
      ...c,
      fStartGHz: 0.2,
      fStopGHz: 6,
      boundary: "MUR",
      marginXY: 6,
      marginZ: 8,
      ports: [padPort(m, "P1.pin1", 1, true), padPort(m, "P2.pin1", 2, false)],
    }),
  },
  {
    id: "patch-antenna",
    title: "2.4 GHz patch antenna",
    description: "29 × 38 mm patch, probe feed 8 mm off centre, far-field pattern.",
    file: "patch-antenna.circuit.json",
    configure: (c, m) => {
      const pad = m.pads[0]
      return {
        ...c,
        fStartGHz: 1.5,
        fStopGHz: 3.5,
        meshRes: 1,
        marginXY: 30,
        marginZ: 30,
        maxTimesteps: 30000,
        ports: [{ id: "port1", kind: "vertical", name: "Feed", x: pad.x - 8, y: pad.y, layer: "top", refLayer: "bottom", impedance: 50, excite: true }],
        nf2ff: { enabled: true, freqGHz: 0 },
      }
    },
  },
  {
    id: "lc-lowpass",
    title: "LC low-pass filter",
    description: "C–L–C π filter with 0603 parts modelled as lumped elements, GND vias.",
    file: "lc-lowpass.circuit.json",
    configure: (c, m) => ({
      ...c,
      fStartGHz: 0.1,
      fStopGHz: 4,
      meshRes: 0.3,
      boundary: "MUR",
      marginXY: 6,
      marginZ: 8,
      ports: [padPort(m, "P1.pin1", 1, true), padPort(m, "P2.pin1", 2, true)],
    }),
  },
]
