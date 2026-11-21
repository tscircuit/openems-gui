import {
  type BBox,
  type Pt,
  bboxOf,
  circlePoly,
  pillPoly,
  rectPoly,
  rotatePt,
  stadiumPoly,
  tessellateBulgeRing,
  unionBBox,
} from "./geom"
import type { Barrel, ComponentInfo, CopperShape, Pad, PcbModel } from "./types"

type El = Record<string, any>

const layerNames = (n: number): string[] => {
  if (n <= 1) return ["top"]
  const inner = Array.from({ length: n - 2 }, (_, i) => `inner${i + 1}`)
  return ["top", ...inner, "bottom"]
}

const layerOf = (l: any): string => (typeof l === "string" ? l : (l?.name ?? "top"))

const fmtValue = (v: number, unit: string): string => {
  const prefixes: [number, string][] = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"],
  ]
  for (const [m, p] of prefixes) if (Math.abs(v) >= m) return `${+(v / m).toPrecision(3)}${p}${unit}`
  return `${v}${unit}`
}

const SI: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }

/** Circuit JSON values are usually numbers but some arrive as strings such as "8.2nH" or "4.7k". */
export const parseValue = (v: unknown): number => {
  if (typeof v === "number") return v
  if (typeof v !== "string") return Number.NaN
  const m = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([fpnuµμmkKMG]?)/.exec(v)
  if (!m) return Number.NaN
  return Number(m[1]) * (m[2] ? SI[m[2]] : 1)
}

/** Unwraps the common containers a "circuit json file" shows up in. */
export const normalizeCircuitJson = (data: unknown): El[] => {
  if (Array.isArray(data)) return data as El[]
  const d = data as any
  if (d && Array.isArray(d.circuit_json)) return d.circuit_json
  if (d && Array.isArray(d.circuitJson)) return d.circuitJson
  if (d && Array.isArray(d.soup)) return d.soup
  throw new Error("Not a Circuit JSON file: expected an array of elements")
}

export const extractPcbModel = (circuitJson: El[]): PcbModel => {
  const warnings: string[] = []
  const byType = new Map<string, El[]>()
  for (const el of circuitJson) {
    if (!el || typeof el.type !== "string") continue
    if (!byType.has(el.type)) byType.set(el.type, [])
    byType.get(el.type)!.push(el)
  }
  const all = (t: string) => byType.get(t) ?? []

  // ---- nets -------------------------------------------------------------
  const netNameByKey = new Map<string, string>()
  const netNameById = new Map<string, string>()
  for (const n of all("source_net")) {
    if (n.subcircuit_connectivity_map_key) netNameByKey.set(n.subcircuit_connectivity_map_key, n.name)
    netNameById.set(n.source_net_id, n.name)
  }
  let anon = 0
  const netOfKey = (key?: string): string | undefined => {
    if (!key) return undefined
    if (!netNameByKey.has(key)) netNameByKey.set(key, `N${++anon}`)
    return netNameByKey.get(key)
  }
  const sourcePortById = new Map(all("source_port").map((p) => [p.source_port_id, p]))
  const sourceCompById = new Map(all("source_component").map((c) => [c.source_component_id, c]))
  const pcbPortById = new Map(all("pcb_port").map((p) => [p.pcb_port_id, p]))
  const pcbCompById = new Map(all("pcb_component").map((c) => [c.pcb_component_id, c]))
  const sourceTraceById = new Map(all("source_trace").map((t) => [t.source_trace_id, t]))
  const netOfPcbPort = (id?: string) => netOfKey(sourcePortById.get(pcbPortById.get(id ?? "")?.source_port_id)?.subcircuit_connectivity_map_key)

  // ---- board ------------------------------------------------------------
  const boardEl = all("pcb_board")[0]
  if (all("pcb_board").length > 1) warnings.push("Multiple pcb_board elements found; using the first one.")

  const copper: CopperShape[] = []
  const barrels: Barrel[] = []
  const pads: Pad[] = []
  const usedLayers = new Set<string>()
  const addCopper = (s: Omit<CopperShape, "bbox">) => {
    if (s.polygon.length < 3) return
    usedLayers.add(s.layer)
    copper.push({ ...s, bbox: bboxOf(s.polygon) })
  }

  const padLabel = (el: El): { label: string; componentId?: string; net?: string } => {
    const pcbPort = pcbPortById.get(el.pcb_port_id)
    const sp = sourcePortById.get(pcbPort?.source_port_id)
    const pc = pcbCompById.get(el.pcb_component_id ?? pcbPort?.pcb_component_id)
    const sc = sourceCompById.get(pc?.source_component_id ?? sp?.source_component_id)
    const pin = sp?.name ?? el.port_hints?.[0] ?? ""
    const comp = sc?.name ?? ""
    const label = comp && pin ? `${comp}.${pin}` : comp || pin || (el.pcb_smtpad_id ?? el.pcb_plated_hole_id)
    return { label, componentId: pc?.pcb_component_id, net: netOfKey(sp?.subcircuit_connectivity_map_key) }
  }

  // ---- SMT pads ---------------------------------------------------------
  for (const el of all("pcb_smtpad")) {
    const layer = layerOf(el.layer)
    let poly: Pt[] | null = null
    const rot = el.ccw_rotation ?? 0
    switch (el.shape) {
      case "rect":
      case "rotated_rect":
        poly = rectPoly(el.x, el.y, el.width, el.height, rot)
        break
      case "circle":
        poly = circlePoly(el.x, el.y, el.radius)
        break
      case "pill":
      case "rotated_pill":
        poly = pillPoly(el.x, el.y, el.width, el.height, rot)
        break
      case "polygon":
        poly = (el.points ?? []).map((p: Pt) => ({ x: p.x, y: p.y }))
        break
      default:
        warnings.push(`Unsupported pcb_smtpad shape "${el.shape}" (${el.pcb_smtpad_id}) was skipped.`)
    }
    if (!poly || poly.length < 3) continue
    const info = padLabel(el)
    const bbox = bboxOf(poly)
    addCopper({ id: el.pcb_smtpad_id, layer, kind: "pad", polygon: poly, net: info.net })
    pads.push({
      id: el.pcb_smtpad_id,
      label: info.label,
      net: info.net,
      layers: [layer],
      x: el.x ?? (bbox.minX + bbox.maxX) / 2,
      y: el.y ?? (bbox.minY + bbox.maxY) / 2,
      bbox,
      polygon: poly,
      componentId: info.componentId,
    })
  }

  // ---- layer stack (needs to know about inner layers before holes) -------
  for (const t of all("pcb_trace")) for (const p of t.route ?? []) {
    if (p.layer) usedLayers.add(layerOf(p.layer))
    if (p.from_layer) usedLayers.add(layerOf(p.from_layer))
    if (p.to_layer) usedLayers.add(layerOf(p.to_layer))
  }
  for (const p of all("pcb_copper_pour")) usedLayers.add(layerOf(p.layer))
  for (const v of all("pcb_via")) for (const l of v.layers ?? []) usedLayers.add(layerOf(l))
  let numLayers = Math.max(2, boardEl?.num_layers ?? 2)
  for (const l of usedLayers) {
    const m = /^inner(\d+)$/.exec(l)
    if (m) numLayers = Math.max(numLayers, Number(m[1]) + 2)
  }
  const layers = layerNames(numLayers)
  const thickness = Number(boardEl?.thickness) > 0 ? Number(boardEl.thickness) : 1.6
  const layerZ: Record<string, number> = {}
  layers.forEach((l, i) => {
    layerZ[l] = thickness * (1 - i / (layers.length - 1))
  })
  const span = (a: string, b: string): string[] => {
    const i = layers.indexOf(a)
    const j = layers.indexOf(b)
    if (i < 0 || j < 0) return layers
    return layers.slice(Math.min(i, j), Math.max(i, j) + 1)
  }

  // ---- plated holes -----------------------------------------------------
  for (const el of all("pcb_plated_hole")) {
    const rot = el.ccw_rotation ?? 0
    let poly: Pt[] | null = null
    let hole = el.hole_diameter ?? Math.min(el.hole_width ?? 0.5, el.hole_height ?? 0.5)
    switch (el.shape) {
      case "circle":
        poly = circlePoly(el.x, el.y, el.outer_diameter / 2)
        break
      case "oval":
      case "pill":
        poly = pillPoly(el.x, el.y, el.outer_width, el.outer_height, rot)
        break
      case "circular_hole_with_rect_pad":
      case "pill_hole_with_rect_pad":
      case "rotated_pill_hole_with_rect_pad":
        poly = rectPoly(el.x, el.y, el.rect_pad_width, el.rect_pad_height, el.rect_ccw_rotation ?? rot)
        break
      case "hole_with_polygon_pad":
        poly = (el.pad_outline ?? []).map((p: Pt) => ({ x: el.x + p.x, y: el.y + p.y }))
        break
      default:
        warnings.push(`Unsupported pcb_plated_hole shape "${el.shape}" was skipped.`)
    }
    if (!poly || poly.length < 3) continue
    if (!(hole > 0)) hole = 0.3
    const info = padLabel(el)
    for (const layer of layers)
      addCopper({ id: `${el.pcb_plated_hole_id}:${layer}`, layer, kind: "pad", polygon: poly, net: info.net })
    barrels.push({ id: el.pcb_plated_hole_id, x: el.x, y: el.y, holeDiameter: hole, layers: [...layers], net: info.net })
    pads.push({
      id: el.pcb_plated_hole_id,
      label: info.label,
      net: info.net,
      layers: [...layers],
      x: el.x,
      y: el.y,
      bbox: bboxOf(poly),
      polygon: poly,
      componentId: info.componentId,
    })
  }

  // ---- vias -------------------------------------------------------------
  const viaKey = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`
  const viaSeen = new Set<string>()
  const addVia = (id: string, x: number, y: number, outer: number, hole: number, viaLayers: string[], net?: string) => {
    for (const layer of viaLayers) addCopper({ id: `${id}:${layer}`, layer, kind: "via", polygon: circlePoly(x, y, outer / 2, 16), net })
    barrels.push({ id, x, y, holeDiameter: hole, layers: viaLayers, net })
    viaSeen.add(viaKey(x, y))
  }
  for (const el of all("pcb_via")) {
    const viaLayers =
      Array.isArray(el.layers) && el.layers.length >= 2
        ? span(layerOf(el.layers[0]), layerOf(el.layers[el.layers.length - 1]))
        : span(layerOf(el.from_layer ?? "top"), layerOf(el.to_layer ?? "bottom"))
    const net = netOfKey(el.subcircuit_connectivity_map_key) ?? netNameById.get(el.source_net_id)
    addVia(el.pcb_via_id, el.x, el.y, el.outer_diameter ?? 0.6, el.hole_diameter ?? 0.3, viaLayers, net)
  }

  // ---- traces -----------------------------------------------------------
  for (const el of all("pcb_trace")) {
    const route: El[] = el.route ?? []
    const st = sourceTraceById.get(el.source_trace_id)
    const net =
      netOfKey(st?.subcircuit_connectivity_map_key) ??
      netOfPcbPort(route.find((p) => p.start_pcb_port_id)?.start_pcb_port_id) ??
      netNameById.get(el.connection_name)
    let seg = 0
    for (let i = 0; i < route.length; i++) {
      const a = route[i]
      if (a.route_type === "via") {
        if (!viaSeen.has(viaKey(a.x, a.y)))
          addVia(
            `${el.pcb_trace_id}:via${i}`,
            a.x,
            a.y,
            a.outer_diameter ?? 0.6,
            a.hole_diameter ?? 0.3,
            span(layerOf(a.from_layer ?? "top"), layerOf(a.to_layer ?? "bottom")),
            net,
          )
        continue
      }
      const b = route[i + 1]
      if (!b || b.route_type !== "wire" || a.route_type !== "wire") continue
      if (layerOf(a.layer) !== layerOf(b.layer)) continue
      const width = a.width ?? b.width ?? 0.15
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-4) continue
      addCopper({
        id: `${el.pcb_trace_id}:${seg++}`,
        layer: layerOf(a.layer),
        kind: "trace",
        polygon: stadiumPoly({ x: a.x, y: a.y }, { x: b.x, y: b.y }, width),
        net,
      })
    }
  }

  // ---- copper pours -----------------------------------------------------
  for (const el of all("pcb_copper_pour")) {
    const layer = layerOf(el.layer)
    const net = netNameById.get(el.source_net_id)
    if (el.shape === "rect") {
      const c = el.center ?? { x: 0, y: 0 }
      addCopper({ id: el.pcb_copper_pour_id, layer, kind: "pour", polygon: rectPoly(c.x, c.y, el.width, el.height, el.rotation ?? 0), net })
    } else if (el.shape === "polygon") {
      addCopper({ id: el.pcb_copper_pour_id, layer, kind: "pour", polygon: el.points ?? [], net })
    } else if (el.shape === "brep") {
      const outer = tessellateBulgeRing(el.brep_shape?.outer_ring?.vertices ?? [])
      const holes = (el.brep_shape?.inner_rings ?? []).map((r: El) => tessellateBulgeRing(r.vertices ?? []))
      addCopper({ id: el.pcb_copper_pour_id, layer, kind: "pour", polygon: outer, holes: holes.length ? holes : undefined, net })
    } else warnings.push(`Unsupported pcb_copper_pour shape "${el.shape}" was skipped.`)
  }

  // ---- board bounds -----------------------------------------------------
  let bounds: BBox
  let outline: Pt[] | undefined
  if (boardEl?.outline?.length >= 3) {
    outline = boardEl.outline.map((p: Pt) => ({ x: p.x, y: p.y }))
    bounds = bboxOf(outline!)
    warnings.push("Board has a custom outline; the substrate is simulated as its bounding rectangle.")
  } else if (boardEl && boardEl.width > 0 && boardEl.height > 0) {
    const c = boardEl.center ?? { x: 0, y: 0 }
    bounds = { minX: c.x - boardEl.width / 2, maxX: c.x + boardEl.width / 2, minY: c.y - boardEl.height / 2, maxY: c.y + boardEl.height / 2 }
  } else {
    if (copper.length === 0) throw new Error("Circuit JSON has no pcb_board and no copper (pads, traces, pours) to simulate.")
    bounds = copper.map((c) => c.bbox).reduce(unionBBox)
    bounds = { minX: bounds.minX - 2, minY: bounds.minY - 2, maxX: bounds.maxX + 2, maxY: bounds.maxY + 2 }
    warnings.push("No pcb_board element found; using the copper bounding box plus 2 mm as the substrate.")
  }
  if (copper.length === 0) warnings.push("No copper found in this Circuit JSON (no pads, traces, vias or pours).")

  // ---- routing problems reported by the producer of the file ------------
  const routingErrors = circuitJson.filter((e) => e?.type === "pcb_trace_missing_error" || e?.type === "pcb_autorouting_error")
  if (routingErrors.length)
    warnings.push(
      `This Circuit JSON reports ${routingErrors.length} routing error${routingErrors.length === 1 ? "" : "s"} — some connections have no copper and will be simulated as open. First: ${String(routingErrors[0].message ?? "").slice(0, 140)}`,
    )

  // ---- components -------------------------------------------------------
  const components: ComponentInfo[] = []
  for (const pc of all("pcb_component")) {
    const sc = sourceCompById.get(pc.source_component_id)
    const padIds = pads.filter((p) => p.componentId === pc.pcb_component_id).map((p) => p.id)
    const info: ComponentInfo = { id: pc.pcb_component_id, name: sc?.name ?? pc.pcb_component_id, ftype: sc?.ftype, padIds }
    if (padIds.length === 2 && sc) {
      const r = parseValue(sc.resistance)
      const c = parseValue(sc.capacitance)
      const l = parseValue(sc.inductance)
      if (sc.ftype === "simple_resistor" && r >= 0) info.passive = { kind: "R", value: r, display: fmtValue(r, "Ω") }
      else if (sc.ftype === "simple_capacitor" && c > 0) info.passive = { kind: "C", value: c, display: fmtValue(c, "F") }
      else if (sc.ftype === "simple_inductor" && l > 0) info.passive = { kind: "L", value: l, display: fmtValue(l, "H") }
    }
    components.push(info)
  }

  // sort copper so pours draw beneath everything else
  const order = { pour: 0, plane: 0, trace: 1, pad: 2, via: 3 } as const
  copper.sort((a, b) => order[a.kind] - order[b.kind])

  return {
    board: { ...bounds, thickness, material: boardEl?.material ?? "fr4", outline },
    layers,
    layerZ,
    copper,
    barrels,
    pads,
    components,
    nets: Array.from(new Set(copper.map((c) => c.net).filter(Boolean) as string[])).sort(),
    warnings,
  }
}

export { rotatePt }
