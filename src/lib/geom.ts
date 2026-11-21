export interface Pt {
  x: number
  y: number
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const rotatePt = (p: Pt, center: Pt, deg: number): Pt => {
  if (!deg) return p
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c }
}

export const rectPoly = (cx: number, cy: number, w: number, h: number, ccwDeg = 0): Pt[] => {
  const c = { x: cx, y: cy }
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ].map((p) => rotatePt(p, c, ccwDeg))
}

export const circlePoly = (cx: number, cy: number, r: number, n = 20): Pt[] => {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** Rounded-end segment ("stadium") from a to b with the given width. */
export const stadiumPoly = (a: Pt, b: Pt, width: number, capSegments = 6): Pt[] => {
  const r = width / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return circlePoly(a.x, a.y, r, capSegments * 2)
  const ang = Math.atan2(dy, dx)
  const pts: Pt[] = []
  // cap around b: from ang-90 to ang+90
  for (let i = 0; i <= capSegments; i++) {
    const t = ang - Math.PI / 2 + (Math.PI * i) / capSegments
    pts.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) })
  }
  // cap around a: from ang+90 to ang+270
  for (let i = 0; i <= capSegments; i++) {
    const t = ang + Math.PI / 2 + (Math.PI * i) / capSegments
    pts.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) })
  }
  return pts
}

/** Pill (stadium) centred on (cx, cy) with overall width/height. */
export const pillPoly = (cx: number, cy: number, w: number, h: number, ccwDeg = 0): Pt[] => {
  const c = { x: cx, y: cy }
  let pts: Pt[]
  if (Math.abs(w - h) < 1e-9) pts = circlePoly(cx, cy, w / 2)
  else if (w > h) pts = stadiumPoly({ x: cx - (w - h) / 2, y: cy }, { x: cx + (w - h) / 2, y: cy }, h)
  else pts = stadiumPoly({ x: cx, y: cy - (h - w) / 2 }, { x: cx, y: cy + (h - w) / 2 }, w)
  return pts.map((p) => rotatePt(p, c, ccwDeg))
}

export const bboxOf = (pts: Pt[]): BBox => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export const unionBBox = (a: BBox, b: BBox): BBox => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
})

export const bboxIntersects = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

export const pointInPolygon = (p: Pt, poly: Pt[]): boolean => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export const polygonArea = (poly: Pt[]): number => {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y
  return Math.abs(s) / 2
}

/** Sutherland–Hodgman clip of a polygon against an axis-aligned rectangle. */
export const clipPolygonToRect = (poly: Pt[], r: BBox): Pt[] => {
  type Edge = { inside: (p: Pt) => boolean; cut: (a: Pt, b: Pt) => Pt }
  const atX = (x: number) => (a: Pt, b: Pt) => ({ x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) })
  const atY = (y: number) => (a: Pt, b: Pt) => ({ x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y), y })
  const edges: Edge[] = [
    { inside: (p) => p.x >= r.minX, cut: atX(r.minX) },
    { inside: (p) => p.x <= r.maxX, cut: atX(r.maxX) },
    { inside: (p) => p.y >= r.minY, cut: atY(r.minY) },
    { inside: (p) => p.y <= r.maxY, cut: atY(r.maxY) },
  ]
  let out = poly
  for (const e of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      const ci = e.inside(cur)
      const pi = e.inside(prev)
      if (ci) {
        if (!pi) out.push(e.cut(prev, cur))
        out.push(cur)
      } else if (pi) out.push(e.cut(prev, cur))
    }
    if (out.length === 0) break
  }
  return out
}

/**
 * Splits a polygon with holes into hole-free trapezoids (even-odd scanline
 * decomposition). openEMS polygons cannot carry holes, so pours with
 * clearance cut-outs are emitted as a set of trapezoids instead.
 */
export const decomposeWithHoles = (outer: Pt[], holes: Pt[][]): Pt[][] => {
  if (holes.length === 0) return [outer]
  const rings = [outer, ...holes]
  const ys = Array.from(new Set(rings.flat().map((p) => +p.y.toFixed(6)))).sort((a, b) => a - b)
  const edges: [Pt, Pt][] = []
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      if (Math.abs(a.y - b.y) > 1e-9) edges.push(a.y < b.y ? [a, b] : [b, a])
    }
  const xAt = (e: [Pt, Pt], y: number) => e[0].x + ((e[1].x - e[0].x) * (y - e[0].y)) / (e[1].y - e[0].y)
  const out: Pt[][] = []
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i]
    const y1 = ys[i + 1]
    if (y1 - y0 < 1e-6) continue
    const ym = (y0 + y1) / 2
    const active = edges.filter((e) => e[0].y <= ym && e[1].y >= ym).sort((a, b) => xAt(a, ym) - xAt(b, ym))
    for (let k = 0; k + 1 < active.length; k += 2) {
      const l = active[k]
      const r = active[k + 1]
      const quad = [
        { x: xAt(l, y0), y: y0 },
        { x: xAt(r, y0), y: y0 },
        { x: xAt(r, y1), y: y1 },
        { x: xAt(l, y1), y: y1 },
      ]
      if (polygonArea(quad) > 1e-9) out.push(quad)
    }
  }
  return out
}

/** Expands a ring whose vertices may carry DXF-style `bulge` arc factors. */
export const tessellateBulgeRing = (verts: Array<Pt & { bulge?: number }>, segPerQuarter = 6): Pt[] => {
  const out: Pt[] = []
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]
    const b = verts[(i + 1) % verts.length]
    out.push({ x: a.x, y: a.y })
    const bulge = a.bulge ?? 0
    if (Math.abs(bulge) < 1e-9) continue
    const theta = 4 * Math.atan(bulge)
    const chord = Math.hypot(b.x - a.x, b.y - a.y)
    if (chord < 1e-9) continue
    const radius = chord / (2 * Math.sin(Math.abs(theta) / 2))
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const h = radius * Math.cos(Math.abs(theta) / 2) * Math.sign(bulge)
    const nx = -(b.y - a.y) / chord
    const ny = (b.x - a.x) / chord
    const c = { x: mid.x + nx * h, y: mid.y + ny * h }
    const a0 = Math.atan2(a.y - c.y, a.x - c.x)
    const n = Math.max(1, Math.ceil((Math.abs(theta) / (Math.PI / 2)) * segPerQuarter))
    for (let k = 1; k < n; k++) {
      const t = a0 + (theta * k) / n
      out.push({ x: c.x + radius * Math.cos(t), y: c.y + radius * Math.sin(t) })
    }
  }
  return out
}
