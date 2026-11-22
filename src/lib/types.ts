import type { BBox, Pt } from "./geom"

/** Everything is in millimetres unless noted. */

export interface CopperShape {
  id: string
  layer: string
  kind: "trace" | "pad" | "pour" | "via" | "plane"
  polygon: Pt[]
  holes?: Pt[][]
  bbox: BBox
  net?: string
}

export interface Barrel {
  id: string
  x: number
  y: number
  holeDiameter: number
  layers: string[]
  net?: string
}

export interface Pad {
  id: string
  label: string
  net?: string
  layers: string[]
  x: number
  y: number
  bbox: BBox
  polygon: Pt[]
  componentId?: string
}

export interface ComponentInfo {
  id: string
  name: string
  ftype?: string
  padIds: string[]
  /** For two-pad passives */
  passive?: { kind: "R" | "C" | "L"; value: number; display: string }
}

export interface PcbModel {
  board: BBox & { thickness: number; material: string; outline?: Pt[] }
  /** top → bottom */
  layers: string[]
  /** z of each copper layer; bottom = 0, top = thickness */
  layerZ: Record<string, number>
  copper: CopperShape[]
  barrels: Barrel[]
  pads: Pad[]
  components: ComponentInfo[]
  nets: string[]
  warnings: string[]
}

export type Boundary = "PML_8" | "MUR" | "PEC" | "PMC"

export type PortDef =
  | {
      id: string
      kind: "vertical"
      name: string
      x: number
      y: number
      layer: string
      refLayer: string
      impedance: number
      excite: boolean
      padId?: string
    }
  | {
      id: string
      kind: "lateral"
      name: string
      padA: string
      padB: string
      impedance: number
      excite: boolean
    }

export interface SimConfig {
  fStartGHz: number
  fStopGHz: number
  freqPoints: number
  epsR: number
  tanD: number
  thickness: number
  copperModel: "pec" | "sheet"
  copperThicknessUm: number
  copperConductivity: number
  /** Add an ideal solid plane covering the board on this layer */
  groundPlaneLayer: string | null
  boundary: Boundary
  marginXY: number
  marginZ: number
  meshRes: number
  cellsPerWavelength: number
  substrateCells: number
  endCriteriaDb: number
  maxTimesteps: number
  modelPassives: boolean
  ports: PortDef[]
  nf2ff: { enabled: boolean; freqGHz: number }
  fields: FieldDumpConfig
  region: BBox | null
  threads: number
}

/** Which fields the solver records for the 3D field views. */
export interface FieldDumpConfig {
  /** E and H phasors in a volume around the board, at `freqsGHz` */
  frequency: boolean
  /** up to three frequencies; empty = the band centre */
  freqsGHz: number[]
  /** E field over time on a plane inside the top dielectric layer (a pulse movie) */
  time: boolean
  /** how far above and below the board the recorded volume extends, mm */
  height: number
}

export interface SimPortGeom {
  number: number
  name: string
  R: number
  start: [number, number, number]
  stop: [number, number, number]
  direction: "x" | "y" | "z"
  excite: boolean
}

export interface SimLumped {
  name: string
  kind: "R" | "C" | "L"
  value: number
  start: [number, number, number]
  stop: [number, number, number]
  direction: "x" | "y" | "z"
}

/** A field recording: a box (or plane) of the grid, in the frequency or the time domain. */
export interface SimDump {
  name: string
  quantity: "E" | "H"
  domain: "freq" | "time"
  start: [number, number, number]
  stop: [number, number, number]
  /** keep every n-th grid point along x, y, z */
  sub: [number, number, number]
  freqs?: number[]
  max_frames?: number
}

/** The self-contained job description consumed by engine/run_sim.py */
export interface SimInput {
  version: 1
  unit: number
  f_start: number
  f_stop: number
  freq_points: number
  end_criteria_db: number
  max_timesteps: number
  boundaries: [Boundary, Boundary, Boundary, Boundary, Boundary, Boundary]
  mesh: { x: number[]; y: number[]; z: number[] }
  substrate: { epsilon: number; kappa: number; start: [number, number, number]; stop: [number, number, number] }
  copper: { model: "pec" | "sheet"; conductivity: number; thickness_m: number }
  polygons: Array<{ z: number; points: [number, number][] }>
  vias: Array<{ x: number; y: number; z0: number; z1: number; radius: number }>
  lumped: SimLumped[]
  ports: SimPortGeom[]
  nf2ff: { enabled: boolean; freq: number }
  dumps: SimDump[]
  threads: number
}

export interface BuildResult {
  /** null while there are errors */
  input: SimInput | null
  /** the same model whenever the geometry and mesh could be built, even if the ports are incomplete */
  preview: SimInput | null
  errors: string[]
  warnings: string[]
  stats: {
    nx: number
    ny: number
    nz: number
    cells: number
    minCell: number
    polygons: number
    estTimestepPs: number
    region: BBox
    /** grid points recorded per frame by the field dumps */
    dumpPoints: { volume: number; plane: number }
    /** worst-case size of the temporary time-domain recording if the run uses every timestep */
    movieTempBytes: number
  } | null
  ports: SimPortGeom[]
  lumped: SimLumped[]
}

export interface SimResults {
  freq: number[]
  ports: Array<{ number: number; name: string; R: number }>
  /** s[`${to}_${from}`] = { re, im } */
  s: Record<string, { re: number[]; im: number[] }>
  zin: Record<string, { re: number[]; im: number[] }>
  excited: number[]
  nf2ff?: Record<
    string,
    {
      freq: number
      dmax_dbi: number
      efficiency: number
      theta: number[]
      phi: number[]
      /** directivity (dBi) cuts over theta for phi=0° and phi=90° */
      cut_xz: number[]
      cut_yz: number[]
      /** directivity (dBi) over the full sphere, d_dbi[theta][phi] */
      pattern?: { theta: number[]; phi: number[]; d_dbi: number[][] }
    }
  >
  /** recorded fields per excited port */
  fields?: Record<string, FieldSet[]>
  runs: Array<{ port: number; seconds: number; cells: number }>
}

/**
 * One recorded field, stored as int16 in `file`: [frame][component][z][y][x], value = int16 × scale.
 * Frequency-domain sets have 6 components per frame (Re Fx, Im Fx, Re Fy, Im Fy, Re Fz, Im Fz),
 * time-domain sets 3 (Fx, Fy, Fz).
 */
export interface FieldSet {
  name: string
  quantity: "E" | "H"
  domain: "freq" | "time"
  file: string
  x: number[]
  y: number[]
  z: number[]
  frames: Array<{ f?: number; t?: number }>
  components: 3 | 6
  scale: number
}

/** Result of an openEMS setup-only run (the Mesh tab). */
export interface MeshCheck {
  status: "idle" | "running" | "done" | "failed"
  /** hash of the sim.json it was built from */
  key: string
  error?: string
  log: string[]
  seconds?: number
  stats: {
    dims?: [number, number, number]
    cells?: number
    operatorBytes?: number
    fieldBytes?: number
    pecEdges?: number
    timestepS?: number
    nyquistTs?: number
    excitationTs?: number
  }
  pec?: { points: number; edges: number }
}
