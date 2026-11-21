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

export const EXAMPLES: ExampleDef[] = [
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
