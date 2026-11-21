import { type BBox, type Pt, bboxIntersects, clipPolygonToRect, decomposeWithHoles, pointInPolygon, polygonArea, unionBBox } from "./geom"
import { type LineSpec, fillMesh, mergeLines, minCell } from "./mesh"
import type { BuildResult, Pad, PcbModel, PortDef, SimConfig, SimInput, SimLumped, SimPortGeom } from "./types"

const C0 = 299792458
const EPS0 = 8.854187817e-12

export const SUBSTRATE_PRESETS: Record<string, { epsR: number; tanD: number; label: string }> = {
  fr4: { epsR: 4.4, tanD: 0.02, label: "FR-4" },
  fr1: { epsR: 4.8, tanD: 0.03, label: "FR-1" },
  ro4003c: { epsR: 3.55, tanD: 0.0027, label: "Rogers RO4003C" },
  ro4350b: { epsR: 3.66, tanD: 0.0037, label: "Rogers RO4350B" },
  ptfe: { epsR: 2.1, tanD: 0.0002, label: "PTFE" },
  air: { epsR: 1, tanD: 0, label: "Air (no dielectric)" },
}

export const defaultConfig = (model: PcbModel): SimConfig => {
  const preset = SUBSTRATE_PRESETS[model.board.material] ?? SUBSTRATE_PRESETS.fr4
  const boardSize = Math.max(model.board.maxX - model.board.minX, model.board.maxY - model.board.minY)
  return {
    fStartGHz: 0.5,
    fStopGHz: 6,
    freqPoints: 401,
    epsR: preset.epsR,
    tanD: preset.tanD,
    thickness: model.board.thickness,
    copperModel: "pec",
    copperThicknessUm: 35,
    copperConductivity: 5.8e7,
    groundPlaneLayer: null,
    boundary: "PML_8",
    marginXY: 10,
    marginZ: 10,
    meshRes: boardSize > 80 ? 1 : 0.5,
    cellsPerWavelength: 15,
    substrateCells: 4,
    endCriteriaDb: -40,
    maxTimesteps: 60000,
    modelPassives: true,
    ports: [],
    nf2ff: { enabled: false, freqGHz: 2.4 },
    region: null,
    threads: 0,
  }
}

/** Geometry of a lumped element / port stretched between the facing edges of two pads. */
export const lateralGeom = (
  a: Pad,
  b: Pad,
): { direction: "x" | "y"; start: [number, number]; stop: [number, number] } | { error: string } => {
  const gapX = Math.max(b.bbox.minX - a.bbox.maxX, a.bbox.minX - b.bbox.maxX)
  const gapY = Math.max(b.bbox.minY - a.bbox.maxY, a.bbox.minY - b.bbox.maxY)
  if (gapX <= 0 && gapY <= 0) return { error: `pads ${a.label} and ${b.label} overlap` }
  if (gapX >= gapY) {
    const lo = Math.max(a.bbox.minY, b.bbox.minY)
    const hi = Math.min(a.bbox.maxY, b.bbox.maxY)
    if (hi < lo) return { error: `pads ${a.label} and ${b.label} are not aligned along x or y` }
    const y = (lo + hi) / 2
    return a.bbox.maxX <= b.bbox.minX
      ? { direction: "x", start: [a.bbox.maxX, y], stop: [b.bbox.minX, y] }
      : { direction: "x", start: [a.bbox.minX, y], stop: [b.bbox.maxX, y] }
  }
  const lo = Math.max(a.bbox.minX, b.bbox.minX)
  const hi = Math.min(a.bbox.maxX, b.bbox.maxX)
  if (hi < lo) return { error: `pads ${a.label} and ${b.label} are not aligned along x or y` }
  const x = (lo + hi) / 2
  return a.bbox.maxY <= b.bbox.minY
    ? { direction: "y", start: [x, a.bbox.maxY], stop: [x, b.bbox.minY] }
    : { direction: "y", start: [x, a.bbox.minY], stop: [x, b.bbox.maxY] }
}

export const copperAt = (model: PcbModel, config: Pick<SimConfig, "groundPlaneLayer">, layer: string, p: Pt): boolean => {
  if (config.groundPlaneLayer === layer) return true
  for (const c of model.copper) {
    if (c.layer !== layer) continue
    if (p.x < c.bbox.minX || p.x > c.bbox.maxX || p.y < c.bbox.minY || p.y > c.bbox.maxY) continue
    if (!pointInPolygon(p, c.polygon)) continue
    if (c.holes?.some((h) => pointInPolygon(p, h))) continue
    return true
  }
  return false
}

export const layerZMap = (model: PcbModel, thickness: number): Record<string, number> => {
  const z: Record<string, number> = {}
  model.layers.forEach((l, i) => {
    z[l] = model.layers.length > 1 ? thickness * (1 - i / (model.layers.length - 1)) : thickness
  })
  return z
}

export const buildSimulation = (model: PcbModel, config: SimConfig): BuildResult => {
  const errors: string[] = []
  const warnings: string[] = []
  const fail = (): BuildResult => ({ input: null, errors, warnings, stats: null, ports: [], lumped: [] })

  const fStart = config.fStartGHz * 1e9
  const fStop = config.fStopGHz * 1e9
  if (!(fStop > 0) || !(fStart >= 0) || fStop <= fStart) errors.push("Frequency range is invalid: stop must be greater than start.")
  if (!(config.epsR >= 1)) errors.push("Substrate εr must be ≥ 1.")
  if (!(config.thickness > 0)) errors.push("Substrate thickness must be positive.")
  if (!(config.meshRes > 0)) errors.push("Copper mesh resolution must be positive.")
  if (!(config.marginXY > 0) || !(config.marginZ > 0)) errors.push("Air margins must be positive.")
  if (errors.length) return fail()

  const board: BBox = { minX: model.board.minX, minY: model.board.minY, maxX: model.board.maxX, maxY: model.board.maxY }
  let region = board
  if (config.region) {
    region = {
      minX: Math.max(board.minX, config.region.minX),
      minY: Math.max(board.minY, config.region.minY),
      maxX: Math.min(board.maxX, config.region.maxX),
      maxY: Math.min(board.maxY, config.region.maxY),
    }
    if (region.maxX - region.minX < 1e-3 || region.maxY - region.minY < 1e-3) {
      errors.push("Simulation region does not overlap the board.")
      return fail()
    }
  }
  const zOf = layerZMap(model, config.thickness)
  const inRegion = (x: number, y: number) => x >= region.minX - 1e-9 && x <= region.maxX + 1e-9 && y >= region.minY - 1e-9 && y <= region.maxY + 1e-9

  // ---- copper polygons --------------------------------------------------
  const polygons: SimInput["polygons"] = []
  const xs: LineSpec[] = []
  const ys: LineSpec[] = []
  let copperBox: BBox | null = null
  const edgeMin = config.meshRes * 0.5
  const pushPoly = (pts: Pt[], z: number) => {
    const clipped = config.region ? clipPolygonToRect(pts, region) : pts
    if (clipped.length < 3 || polygonArea(clipped) < 1e-8) return
    polygons.push({ z, points: clipped.map((p) => [+p.x.toFixed(6), +p.y.toFixed(6)] as [number, number]) })
    for (let i = 0; i < clipped.length; i++) {
      const a = clipped[i]
      const b = clipped[(i + 1) % clipped.length]
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) >= edgeMin) xs.push({ pos: a.x, priority: 1 })
      if (Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) >= edgeMin) ys.push({ pos: a.y, priority: 1 })
    }
  }
  for (const c of model.copper) {
    if (!bboxIntersects(c.bbox, region)) continue
    const z = zOf[c.layer]
    if (z === undefined) continue
    const clippedBox: BBox = {
      minX: Math.max(c.bbox.minX, region.minX),
      minY: Math.max(c.bbox.minY, region.minY),
      maxX: Math.min(c.bbox.maxX, region.maxX),
      maxY: Math.min(c.bbox.maxY, region.maxY),
    }
    copperBox = copperBox ? unionBBox(copperBox, clippedBox) : clippedBox
    for (const part of decomposeWithHoles(c.polygon, c.holes ?? [])) pushPoly(part, z)
  }
  if (config.groundPlaneLayer && zOf[config.groundPlaneLayer] !== undefined) {
    pushPoly(
      [
        { x: region.minX, y: region.minY },
        { x: region.maxX, y: region.minY },
        { x: region.maxX, y: region.maxY },
        { x: region.minX, y: region.maxY },
      ],
      zOf[config.groundPlaneLayer],
    )
    copperBox = region
  }
  if (polygons.length === 0) {
    errors.push("No copper inside the simulation region.")
    return fail()
  }

  // ---- vias -------------------------------------------------------------
  const vias: SimInput["vias"] = []
  for (const b of model.barrels) {
    if (!inRegion(b.x, b.y)) continue
    const zs = b.layers.map((l) => zOf[l]).filter((z) => z !== undefined)
    if (zs.length < 2) continue
    vias.push({ x: b.x, y: b.y, z0: Math.min(...zs), z1: Math.max(...zs), radius: Math.max(b.holeDiameter / 2, 0.05) })
    xs.push({ pos: b.x, priority: 2 })
    ys.push({ pos: b.y, priority: 2 })
  }

  // ---- ports ------------------------------------------------------------
  const padById = new Map(model.pads.map((p) => [p.id, p]))
  const ports: SimPortGeom[] = []
  const portPadPairs = new Set<string>()
  const pairKey = (a: string, b: string) => [a, b].sort().join("|")
  const addLateralLines = (g: { direction: "x" | "y"; start: [number, number]; stop: [number, number] }) => {
    xs.push({ pos: g.start[0], priority: 3 }, { pos: g.stop[0], priority: 3 })
    ys.push({ pos: g.start[1], priority: 3 }, { pos: g.stop[1], priority: 3 })
  }
  config.ports.forEach((p: PortDef, i) => {
    const number = i + 1
    const label = p.name || `Port ${number}`
    if (!(p.impedance > 0)) {
      errors.push(`${label}: impedance must be positive.`)
      return
    }
    if (p.kind === "vertical") {
      const z1 = zOf[p.layer]
      const z0 = zOf[p.refLayer]
      if (z1 === undefined || z0 === undefined || p.layer === p.refLayer) {
        errors.push(`${label}: signal and reference layers must be two different copper layers.`)
        return
      }
      if (!inRegion(p.x, p.y)) {
        errors.push(`${label}: position (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) is outside the simulation region.`)
        return
      }
      if (!copperAt(model, config, p.layer, p)) warnings.push(`${label}: no copper on "${p.layer}" at the port position — the port is not attached to anything.`)
      if (!copperAt(model, config, p.refLayer, p))
        warnings.push(`${label}: no copper on reference layer "${p.refLayer}" under the port. Add a ground plane or pick another reference layer.`)
      const shorting = model.barrels.find(
        (b) => b.layers.includes(p.layer) && b.layers.includes(p.refLayer) && Math.hypot(b.x - p.x, b.y - p.y) < Math.max(b.holeDiameter / 2, config.meshRes / 2),
      )
      if (shorting) warnings.push(`${label}: sits on a via / plated hole that already connects "${p.layer}" to "${p.refLayer}", so the port is shorted. Move it or pick another reference layer.`)
      ports.push({ number, name: label, R: p.impedance, start: [p.x, p.y, z0], stop: [p.x, p.y, z1], direction: "z", excite: p.excite })
      xs.push({ pos: p.x, priority: 3 })
      ys.push({ pos: p.y, priority: 3 })
    } else {
      const a = padById.get(p.padA)
      const b = padById.get(p.padB)
      if (!a || !b) {
        errors.push(`${label}: pad not found in this board.`)
        return
      }
      const layer = a.layers.find((l) => b.layers.includes(l))
      if (!layer) {
        errors.push(`${label}: pads ${a.label} and ${b.label} are on different layers.`)
        return
      }
      const g = lateralGeom(a, b)
      if ("error" in g) {
        errors.push(`${label}: ${g.error}.`)
        return
      }
      if (!inRegion(g.start[0], g.start[1]) || !inRegion(g.stop[0], g.stop[1])) {
        errors.push(`${label}: outside the simulation region.`)
        return
      }
      const z = zOf[layer]
      ports.push({ number, name: label, R: p.impedance, start: [...g.start, z], stop: [...g.stop, z], direction: g.direction, excite: p.excite })
      addLateralLines(g)
      portPadPairs.add(pairKey(a.id, b.id))
    }
  })
  if (ports.length === 0 && errors.length === 0) errors.push("Add at least one port: click a pad on the board, then choose how to connect it.")
  if (ports.length > 0 && !ports.some((p) => p.excite)) errors.push("At least one port must be excited.")

  // ---- lumped passives --------------------------------------------------
  const lumped: SimLumped[] = []
  if (config.modelPassives) {
    for (const comp of model.components) {
      if (!comp.passive || comp.padIds.length !== 2) continue
      const a = padById.get(comp.padIds[0])
      const b = padById.get(comp.padIds[1])
      if (!a || !b || portPadPairs.has(pairKey(a.id, b.id))) continue
      const layer = a.layers.find((l) => b.layers.includes(l))
      if (!layer) continue
      const g = lateralGeom(a, b)
      if ("error" in g) {
        warnings.push(`${comp.name}: not modelled as a lumped element (${g.error}).`)
        continue
      }
      if (!inRegion(g.start[0], g.start[1]) || !inRegion(g.stop[0], g.stop[1])) continue
      if (comp.passive.kind === "R" && comp.passive.value === 0) {
        // 0 ohm jumper: bridge the pads with copper
        const [x0, y0] = g.start
        const [x1, y1] = g.stop
        const w = config.meshRes
        pushPoly(
          g.direction === "x"
            ? [
                { x: x0, y: y0 - w / 2 },
                { x: x1, y: y0 - w / 2 },
                { x: x1, y: y0 + w / 2 },
                { x: x0, y: y0 + w / 2 },
              ]
            : [
                { x: x0 - w / 2, y: y0 },
                { x: x0 + w / 2, y: y0 },
                { x: x0 + w / 2, y: y1 },
                { x: x0 - w / 2, y: y1 },
              ],
          zOf[layer],
        )
        continue
      }
      const z = zOf[layer]
      lumped.push({ name: comp.name, kind: comp.passive.kind, value: comp.passive.value, start: [...g.start, z], stop: [...g.stop, z], direction: g.direction })
      addLateralLines(g)
    }
  }
  if (errors.length) return { ...fail(), ports, lumped }

  // ---- mesh -------------------------------------------------------------
  const lambdaMin = (C0 / fStop) * 1e3 // mm, in air
  const airMax = lambdaMin / config.cellsPerWavelength
  const subMax = airMax / Math.sqrt(config.epsR)
  const res = Math.min(config.meshRes, subMax)
  const edgeCells = config.boundary === "PML_8" ? 12 : 4
  const marginMaxXY = Math.min(airMax, config.marginXY / edgeCells)
  const marginMaxZ = Math.min(airMax, config.marginZ / edgeCells)
  const cb = copperBox ?? region
  const fine: BBox = {
    minX: Math.max(region.minX, cb.minX - 2 * res),
    minY: Math.max(region.minY, cb.minY - 2 * res),
    maxX: Math.min(region.maxX, cb.maxX + 2 * res),
    maxY: Math.min(region.maxY, cb.maxY + 2 * res),
  }
  const box = {
    minX: region.minX - config.marginXY,
    maxX: region.maxX + config.marginXY,
    minY: region.minY - config.marginXY,
    maxY: region.maxY + config.marginXY,
    minZ: -config.marginZ,
    maxZ: config.thickness + config.marginZ,
  }
  const axis = (lines: LineSpec[], lo: number, hi: number, rLo: number, rHi: number, fLo: number, fHi: number) => {
    const fixed = mergeLines(
      [
        ...lines.filter((l) => l.pos >= rLo - 1e-9 && l.pos <= rHi + 1e-9),
        { pos: lo, priority: 4 },
        { pos: hi, priority: 4 },
        { pos: rLo, priority: 4 },
        { pos: rHi, priority: 4 },
        { pos: fLo, priority: 1 },
        { pos: fHi, priority: 1 },
      ],
      res * 0.5,
    )
    return fillMesh(fixed, (x) => (x < rLo || x > rHi ? marginMaxXY : x >= fLo && x <= fHi ? res : subMax))
  }
  const meshX = axis(xs, box.minX, box.maxX, region.minX, region.maxX, fine.minX, fine.maxX)
  const meshY = axis(ys, box.minY, box.maxY, region.minY, region.maxY, fine.minY, fine.maxY)

  const layerZs = Array.from(new Set(model.layers.map((l) => zOf[l]))).sort((a, b) => a - b)
  const zFixed: number[] = [box.minZ, box.maxZ]
  if (layerZs.length === 1) zFixed.push(0)
  const zStack = layerZs.length === 1 ? [0, layerZs[0]] : layerZs
  for (let i = 0; i < zStack.length; i++) {
    zFixed.push(zStack[i])
    if (i + 1 < zStack.length) {
      const gap = zStack[i + 1] - zStack[i]
      const n = Math.max(1, Math.round((config.substrateCells * gap) / config.thickness))
      for (let k = 1; k < n; k++) zFixed.push(zStack[i] + (gap * k) / n)
    }
  }
  const meshZ = fillMesh(
    Array.from(new Set(zFixed.map((z) => +z.toFixed(6)))),
    (z) => (z < 0 || z > config.thickness ? marginMaxZ : config.thickness),
    1.4,
  )

  const round = (a: number[]) => a.map((v) => +v.toFixed(6))
  const cells = (meshX.length - 1) * (meshY.length - 1) * (meshZ.length - 1)
  const dMin = [minCell(meshX), minCell(meshY), minCell(meshZ)]
  const dt = 1 / (C0 * Math.sqrt(dMin.reduce((s, d) => s + 1 / (d * 1e-3) ** 2, 0)))
  if (cells > 8e6) warnings.push(`Mesh has ${(cells / 1e6).toFixed(1)} M cells — this will be slow and memory hungry. Coarsen the mesh or simulate a sub-region.`)
  if (config.nf2ff.enabled && config.boundary !== "PML_8" && config.boundary !== "MUR")
    warnings.push("Far-field calculation needs absorbing boundaries (PML or MUR).")
  const ffFreq = config.nf2ff.freqGHz > 0 ? config.nf2ff.freqGHz * 1e9 : (fStart + fStop) / 2
  if (config.nf2ff.enabled && Math.min(config.marginXY, config.marginZ) < (C0 / ffFreq) * 1e3 * 0.2)
    warnings.push("Far-field accuracy: the air margin is under λ/5 at the far-field frequency. Around λ/4 is recommended for antennas.")

  const f0 = (fStart + fStop) / 2
  const input: SimInput = {
    version: 1,
    unit: 1e-3,
    f_start: fStart,
    f_stop: fStop,
    freq_points: Math.max(2, Math.round(config.freqPoints)),
    end_criteria_db: config.endCriteriaDb,
    max_timesteps: Math.round(config.maxTimesteps),
    boundaries: [config.boundary, config.boundary, config.boundary, config.boundary, config.boundary, config.boundary],
    mesh: { x: round(meshX), y: round(meshY), z: round(meshZ) },
    substrate: {
      epsilon: config.epsR,
      kappa: config.tanD * 2 * Math.PI * f0 * EPS0 * config.epsR,
      start: [region.minX, region.minY, 0],
      stop: [region.maxX, region.maxY, config.thickness],
    },
    copper: { model: config.copperModel, conductivity: config.copperConductivity, thickness_m: config.copperThicknessUm * 1e-6 },
    polygons,
    vias,
    lumped,
    ports,
    nf2ff: { enabled: config.nf2ff.enabled, freq: config.nf2ff.freqGHz * 1e9 },
    threads: config.threads,
  }
  return {
    input,
    errors,
    warnings,
    stats: {
      nx: meshX.length,
      ny: meshY.length,
      nz: meshZ.length,
      cells,
      minCell: Math.min(...dMin),
      polygons: polygons.length,
      estTimestepPs: dt * 1e12,
      region,
    },
    ports,
    lumped,
  }
}
