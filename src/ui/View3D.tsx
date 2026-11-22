import { type ReactNode, useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { FieldSet, SimInput } from "../lib/types"

/** What to paint on the field slices. Indices refer to the field set's own grid. */
export interface FieldLayer {
  set: FieldSet
  data: Int16Array
  frame: number
  /** radians; frequency-domain sets only */
  phase: number
  display: "mag" | "x" | "y" | "z"
  /** frequency-domain sets: the field at one instant instead of its peak magnitude */
  instant: boolean
  /** dynamic range of the magnitude colour scale */
  rangeDb: number
  /** reference level in raw int16 units (top of the colour scale) */
  ref: number
  slices: { x: number | null; y: number | null; z: number | null }
}

export interface PatternLayer {
  theta: number[]
  phi: number[]
  d_dbi: number[][]
}

export interface PecEdges {
  points: Float32Array
  index: Uint32Array
}

interface Props {
  sim: SimInput
  pec?: PecEdges | null
  field?: FieldLayer | null
  pattern?: PatternLayer | null
  /** start with the mesh lines visible */
  meshInitially?: boolean
  children?: ReactNode
}

/** dB below the maximum directivity covered by the pattern's colour scale */
export const PATTERN_COLOR_DB = 15

const LAYER_PALETTE = ["#d2553f", "#3fa66a", "#d6a02c", "#b06bd0", "#3bb5b5", "#4a86d8"]

// colour maps ---------------------------------------------------------------------------------
const SEQ: Array<[number, number, number]> = [
  [0.0, 0.0, 0.2],
  [0.15, 0.1, 0.55],
  [0.55, 0.1, 0.55],
  [0.9, 0.3, 0.25],
  [1.0, 0.7, 0.1],
  [1.0, 1.0, 0.75],
]
/** t in 0…1 → rgb (dark blue → magenta → orange → pale yellow) */
export const seqColor = (t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] => {
  const u = Math.min(0.9999, Math.max(0, t)) * (SEQ.length - 1)
  const i = Math.floor(u)
  const f = u - i
  for (let c = 0; c < 3; c++) out[c] = SEQ[i][c] + (SEQ[i + 1][c] - SEQ[i][c]) * f
  return out
}
export const seqCss = (t: number) => {
  const [r, g, b] = seqColor(t)
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}

const disposeGroup = (g: THREE.Group) => {
  for (const child of [...g.children]) {
    g.remove(child)
    const o = child as THREE.Mesh
    o.geometry?.dispose?.()
    const m = o.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(m)) for (const x of m) x.dispose()
    else {
      ;(m as any)?.map?.dispose?.()
      m?.dispose?.()
    }
  }
}

const labelSprite = (text: string, filled: boolean) => {
  const c = document.createElement("canvas")
  c.width = c.height = 64
  const g = c.getContext("2d")!
  g.beginPath()
  g.arc(32, 32, 26, 0, Math.PI * 2)
  g.fillStyle = filled ? "#f2c230" : "#1a1a19"
  g.fill()
  g.lineWidth = 5
  g.strokeStyle = "#f2c230"
  g.stroke()
  g.fillStyle = filled ? "#1a1500" : "#f2c230"
  g.font = "bold 34px -apple-system, sans-serif"
  g.textAlign = "center"
  g.textBaseline = "middle"
  g.fillText(text, 32, 34)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }))
  sprite.scale.set(0.028, 0.028, 1)
  sprite.renderOrder = 10
  return sprite
}

interface Slice {
  mesh: THREE.Mesh
  /** index of each vertex inside one component block of the data */
  idx: Uint32Array
  colors: Float32Array
}

interface Stage {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  zGroup: THREE.Group
  geometry: THREE.Group
  substrate: THREE.Group
  meshLines: THREE.Group
  pec: THREE.Group
  slices: THREE.Group
  pattern: THREE.Group
  /** not stretched with the board, so the triad keeps its proportions */
  axes: THREE.Group
  sliceList: Slice[]
  sliceKey: string
  render: () => void
}

export function View3D({ sim, pec, field, pattern, meshInitially = false, children }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const stage = useRef<Stage | null>(null)
  const sub = sim.substrate
  const thickness = Math.max(1e-3, sub.stop[2] - sub.start[2])
  const size = Math.max(sub.stop[0] - sub.start[0], sub.stop[1] - sub.start[1])
  const autoZ = Math.min(20, Math.max(1, Math.round((0.05 * size) / thickness)))
  const [zScale, setZScale] = useState(autoZ)
  const [showMesh, setShowMesh] = useState(meshInitially)
  const [showSubstrate, setShowSubstrate] = useState(true)
  const [showCopper, setShowCopper] = useState(true)
  const [showPec, setShowPec] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  const fitted = useRef("")

  // ---- one-time setup ----
  useEffect(() => {
    const el = wrap.current!
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    } catch (e: any) {
      setFailed(`3D view is unavailable: ${e?.message ?? e}`)
      return
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setClearColor(0x10140f)
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight(0xffffff, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(-0.4, -0.8, 1)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000)
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.zoomSpeed = 1.2
    const mk = () => new THREE.Group()
    const s: Stage = {
      renderer,
      scene,
      camera,
      controls,
      zGroup: mk(),
      geometry: mk(),
      substrate: mk(),
      meshLines: mk(),
      pec: mk(),
      slices: mk(),
      pattern: mk(),
      axes: mk(),
      sliceList: [],
      sliceKey: "",
      render: () => renderer.render(scene, camera),
    }
    s.zGroup.add(s.substrate, s.geometry, s.meshLines, s.pec, s.slices)
    scene.add(s.zGroup, s.pattern, s.axes)
    controls.addEventListener("change", s.render)
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = "100%"
      renderer.domElement.style.height = "100%"
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      s.render()
    })
    ro.observe(el)
    stage.current = s
    return () => {
      ro.disconnect()
      controls.dispose()
      for (const g of [s.geometry, s.substrate, s.meshLines, s.pec, s.slices, s.pattern, s.axes]) disposeGroup(g)
      renderer.dispose()
      renderer.domElement.remove()
      stage.current = null
    }
  }, [])

  const fit = () => {
    const s = stage.current
    if (!s) return
    const cx = (sub.start[0] + sub.stop[0]) / 2
    const cy = (sub.start[1] + sub.stop[1]) / 2
    const cz = ((sub.start[2] + sub.stop[2]) / 2) * zScale
    const r = Math.hypot(sub.stop[0] - sub.start[0], sub.stop[1] - sub.start[1]) / 2 || 1
    const half = Math.min((s.camera.fov * Math.PI) / 360, Math.atan(Math.tan((s.camera.fov * Math.PI) / 360) * s.camera.aspect))
    const dist = (r / Math.sin(half)) * (pattern ? 1.95 : 1.12)
    const dir = new THREE.Vector3(-0.45, -1, 0.75).normalize()
    s.controls.target.set(cx, cy, cz)
    s.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist)
    s.camera.near = dist / 500
    s.camera.far = dist * 50
    s.camera.updateProjectionMatrix()
    s.controls.update()
    s.render()
  }

  // ---- board geometry ----
  useEffect(() => {
    const s = stage.current
    if (!s) return
    disposeGroup(s.geometry)
    disposeGroup(s.substrate)
    disposeGroup(s.meshLines)

    // substrate
    const sx = sub.stop[0] - sub.start[0]
    const sy = sub.stop[1] - sub.start[1]
    const box = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, thickness), new THREE.MeshBasicMaterial({ color: 0x2f6b3c, transparent: true, opacity: 0.28, depthWrite: false }))
    box.position.set((sub.start[0] + sub.stop[0]) / 2, (sub.start[1] + sub.stop[1]) / 2, (sub.start[2] + sub.stop[2]) / 2)
    s.substrate.add(box)
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x5f8f68 }))
    outline.position.copy(box.position)
    s.substrate.add(outline)

    // copper, one merged mesh per layer height
    const zs = Array.from(new Set(sim.polygons.map((p) => p.z))).sort((a, b) => b - a)
    zs.forEach((z, li) => {
      const pos: number[] = []
      const index: number[] = []
      for (const poly of sim.polygons) {
        if (poly.z !== z) continue
        const contour = poly.points.map(([x, y]) => new THREE.Vector2(x, y))
        const base = pos.length / 3
        for (const p of contour) pos.push(p.x, p.y, z)
        for (const f of THREE.ShapeUtils.triangulateShape(contour, [])) index.push(base + f[0], base + f[1], base + f[2])
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
      g.setIndex(index)
      const color = zs.length > 1 && li === zs.length - 1 ? LAYER_PALETTE[LAYER_PALETTE.length - 1] : LAYER_PALETTE[Math.min(li, LAYER_PALETTE.length - 2)]
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }))
      m.userData.copper = true
      m.renderOrder = 1
      s.geometry.add(m)
    })
    for (const v of sim.vias) {
      const h = v.z1 - v.z0
      const c = new THREE.Mesh(new THREE.CylinderGeometry(v.radius, v.radius, h, 12), new THREE.MeshBasicMaterial({ color: 0xc9a227 }))
      c.rotation.x = Math.PI / 2
      c.position.set(v.x, v.y, (v.z0 + v.z1) / 2)
      s.geometry.add(c)
    }
    // ports and lumped elements
    const seg: number[] = []
    for (const p of sim.ports) {
      seg.push(...p.start, ...p.stop)
      const label = labelSprite(String(p.number), p.excite)
      label.position.set((p.start[0] + p.stop[0]) / 2, (p.start[1] + p.stop[1]) / 2, Math.max(p.start[2], p.stop[2]))
      s.geometry.add(label)
    }
    const lseg: number[] = []
    for (const l of sim.lumped) lseg.push(...l.start, ...l.stop)
    const line = (coords: number[], color: number) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(coords, 3))
      const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }))
      ls.renderOrder = 9
      return ls
    }
    // x (red), y (green), z (blue) at the board's lower-left corner
    disposeGroup(s.axes)
    const axes = new THREE.AxesHelper(0.15 * Math.max(sx, sy))
    ;(axes.material as THREE.Material).depthTest = false
    axes.renderOrder = 8
    s.axes.add(axes)
    if (seg.length) s.geometry.add(line(seg, 0xf2c230))
    if (lseg.length) s.geometry.add(line(lseg, 0x7fe0c0))

    // mesh lines: on the top face of the board and on two walls of the simulation box
    const { x, y, z } = sim.mesh
    const [x0, x1, y0, y1, z0, z1] = [x[0], x[x.length - 1], y[0], y[y.length - 1], z[0], z[z.length - 1]]
    const zt = sub.stop[2]
    const floor: number[] = []
    for (const v of x) floor.push(v, y0, zt, v, y1, zt)
    for (const v of y) floor.push(x0, v, zt, x1, v, zt)
    const walls: number[] = []
    for (const v of z) walls.push(x0, y1, v, x1, y1, v, x1, y0, v, x1, y1, v)
    for (const v of x) walls.push(v, y1, z0, v, y1, z1)
    for (const v of y) walls.push(x1, v, z0, x1, v, z1)
    const meshLine = (coords: number[], opacity: number) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(coords, 3))
      const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false }))
      ls.renderOrder = 2
      return ls
    }
    s.meshLines.add(meshLine(floor, 0.16), meshLine(walls, 0.09))
    // simulation box
    const dom = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)),
      new THREE.LineDashedMaterial({ color: 0x7d8a78, dashSize: (x1 - x0) / 60, gapSize: (x1 - x0) / 90 }),
    )
    dom.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    dom.computeLineDistances()
    s.meshLines.add(dom)

    const key = `${sub.start.join(",")}|${sub.stop.join(",")}`
    if (fitted.current !== key) {
      fitted.current = key
      setZScale(autoZ)
      requestAnimationFrame(fit)
    }
    s.render()
  }, [sim])

  // ---- visibility and z exaggeration ----
  useEffect(() => {
    const s = stage.current
    if (!s) return
    s.zGroup.scale.set(1, 1, zScale)
    s.meshLines.visible = showMesh
    s.substrate.visible = showSubstrate
    s.pec.visible = showPec
    for (const o of s.geometry.children)
      if (o.userData.copper) {
        o.visible = showCopper
        ;((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = field ? 0.35 : pec && showPec ? 0.3 : 0.9
      }
    // the far-field pattern is not stretched; keep it centred on the (stretched) board
    s.axes.position.set(sub.start[0], sub.start[1], sub.stop[2] * zScale)
    s.pattern.position.set((sub.start[0] + sub.stop[0]) / 2, (sub.start[1] + sub.stop[1]) / 2, ((sub.start[2] + sub.stop[2]) / 2) * zScale)
    s.render()
  }, [sim, zScale, showMesh, showSubstrate, showCopper, showPec, !!field, !!pec])

  // ---- metal edges as discretised by openEMS ----
  useEffect(() => {
    const s = stage.current
    if (!s) return
    disposeGroup(s.pec)
    if (pec && pec.index.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.BufferAttribute(pec.points, 3))
      g.setIndex(new THREE.BufferAttribute(pec.index, 1))
      const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffb347 }))
      ls.renderOrder = 3
      s.pec.add(ls)
    }
    s.render()
  }, [pec])

  // ---- far-field pattern ----
  useEffect(() => {
    const s = stage.current
    if (!s) return
    disposeGroup(s.pattern)
    if (pattern) {
      const { theta, phi, d_dbi } = pattern
      let dMax = Number.NEGATIVE_INFINITY
      for (const row of d_dbi) for (const v of row) dMax = Math.max(dMax, v)
      const span = 30
      const R = 0.6 * Math.hypot(sub.stop[0] - sub.start[0], sub.stop[1] - sub.start[1])
      const pos: number[] = []
      const col: number[] = []
      const index: number[] = []
      const rgb: [number, number, number] = [0, 0, 0]
      for (let i = 0; i < theta.length; i++)
        for (let j = 0; j < phi.length; j++) {
          const t = Math.max(0, 1 - (dMax - d_dbi[i][j]) / span)
          const r = R * Math.max(0.03, t)
          const th = (theta[i] * Math.PI) / 180
          const ph = (phi[j] * Math.PI) / 180
          pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))
          // colour over the top PATTERN_COLOR_DB only, so a near-omnidirectional pattern still shows its shape
          seqColor(0.15 + 0.85 * Math.max(0, 1 - (dMax - d_dbi[i][j]) / PATTERN_COLOR_DB), rgb)
          col.push(rgb[0], rgb[1], rgb[2])
        }
      const np = phi.length
      for (let i = 0; i + 1 < theta.length; i++)
        for (let j = 0; j + 1 < np; j++) {
          const a = i * np + j
          index.push(a, a + np, a + 1, a + 1, a + np, a + np + 1)
        }
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3))
      g.setIndex(index)
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false }))
      m.renderOrder = 5
      s.pattern.add(m)
      s.pattern.add(new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.07 })))
    }
    requestAnimationFrame(fit)
  }, [pattern])

  // ---- field slices ----
  useEffect(() => {
    const s = stage.current
    if (!s) return
    if (!field) {
      if (s.sliceList.length) {
        disposeGroup(s.slices)
        s.sliceList = []
        s.sliceKey = ""
        s.render()
      }
      return
    }
    const { set, data } = field
    const nx = set.x.length
    const ny = set.y.length
    const nz = set.z.length
    const plane = nx * ny
    const vol = plane * nz
    const key = `${set.file}|${field.slices.x}|${field.slices.y}|${field.slices.z}`
    if (key !== s.sliceKey) {
      disposeGroup(s.slices)
      s.sliceList = []
      s.sliceKey = key
      const add = (nu: number, nv: number, at: (u: number, v: number) => [number, number, number, number]) => {
        if (nu < 2 || nv < 2) return
        const pos = new Float32Array(nu * nv * 3)
        const idx = new Uint32Array(nu * nv)
        for (let v = 0; v < nv; v++)
          for (let u = 0; u < nu; u++) {
            const [px, py, pz, di] = at(u, v)
            const n = v * nu + u
            pos[n * 3] = px
            pos[n * 3 + 1] = py
            pos[n * 3 + 2] = pz
            idx[n] = di
          }
        const index = new Uint32Array((nu - 1) * (nv - 1) * 6)
        let w = 0
        for (let v = 0; v + 1 < nv; v++)
          for (let u = 0; u + 1 < nu; u++) {
            const a = v * nu + u
            index[w++] = a
            index[w++] = a + 1
            index[w++] = a + nu
            index[w++] = a + 1
            index[w++] = a + nu + 1
            index[w++] = a + nu
          }
        const colors = new Float32Array(nu * nv * 4)
        const g = new THREE.BufferGeometry()
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
        g.setAttribute("color", new THREE.BufferAttribute(colors, 4))
        g.setIndex(new THREE.BufferAttribute(index, 1))
        const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false }))
        mesh.renderOrder = 4
        s.slices.add(mesh)
        s.sliceList.push({ mesh, idx, colors })
      }
      const { x: sx, y: sy, z: sz } = field.slices
      if (sz !== null && sz >= 0 && sz < nz) add(nx, ny, (i, j) => [set.x[i], set.y[j], set.z[sz], sz * plane + j * nx + i])
      if (sy !== null && sy >= 0 && sy < ny && nz > 1) add(nx, nz, (i, k) => [set.x[i], set.y[sy], set.z[k], k * plane + sy * nx + i])
      if (sx !== null && sx >= 0 && sx < nx && nz > 1) add(ny, nz, (j, k) => [set.x[sx], set.y[j], set.z[k], k * plane + j * nx + sx])
    }

    // colours
    const C = set.components
    const base = Math.min(set.frames.length - 1, Math.max(0, field.frame)) * C * vol
    const cos = Math.cos(field.phase)
    const sin = Math.sin(field.phase)
    const comp = field.display === "mag" ? -1 : field.display === "x" ? 0 : field.display === "y" ? 1 : 2
    const ref = Math.max(1e-9, field.ref)
    const rgb: [number, number, number] = [0, 0, 0]
    for (const sl of s.sliceList) {
      const { idx, colors } = sl
      for (let n = 0; n < idx.length; n++) {
        const o = base + idx[n]
        let value = 0
        let signed = false
        if (C === 6) {
          if (comp < 0 && !field.instant) {
            let sum = 0
            for (let c = 0; c < 6; c++) {
              const v = data[o + c * vol]
              sum += v * v
            }
            value = Math.sqrt(sum)
          } else if (comp < 0) {
            let sum = 0
            for (let c = 0; c < 3; c++) {
              const v = data[o + 2 * c * vol] * cos - data[o + (2 * c + 1) * vol] * sin
              sum += v * v
            }
            value = Math.sqrt(sum)
          } else if (!field.instant) value = Math.hypot(data[o + 2 * comp * vol], data[o + (2 * comp + 1) * vol])
          else {
            value = data[o + 2 * comp * vol] * cos - data[o + (2 * comp + 1) * vol] * sin
            signed = true
          }
        } else if (comp < 0) {
          const a = data[o]
          const b = data[o + vol]
          const c = data[o + 2 * vol]
          value = Math.sqrt(a * a + b * b + c * c)
        } else {
          value = data[o + comp * vol]
          signed = true
        }
        const m = n * 4
        const mag = Math.abs(value)
        // dB scale for both; signed values get a red (+) / blue (−) pair
        const t = mag <= 0 ? 0 : Math.min(1, Math.max(0, 1 + (20 * Math.log10(mag / ref)) / field.rangeDb))
        if (signed) {
          const pos = value >= 0
          colors[m] = pos ? 0.35 + 0.65 * t : 0.1 + 0.2 * t
          colors[m + 1] = 0.15 + (pos ? 0.35 : 0.5) * t * t
          colors[m + 2] = pos ? 0.1 + 0.15 * t : 0.35 + 0.65 * t
        } else {
          seqColor(t, rgb)
          colors[m] = rgb[0]
          colors[m + 1] = rgb[1]
          colors[m + 2] = rgb[2]
        }
        colors[m + 3] = Math.min(0.95, t * 1.8)
      }
      ;(sl.mesh.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true
    }
    s.render()
  }, [field])

  return (
    <div className="pcb-wrap">
      <div className="pcb-toolbar">
        <label className="layer-toggle">
          <input type="checkbox" checked={showCopper} onChange={(e) => setShowCopper(e.target.checked)} />
          copper
        </label>
        <label className="layer-toggle">
          <input type="checkbox" checked={showSubstrate} onChange={(e) => setShowSubstrate(e.target.checked)} />
          substrate
        </label>
        <label className="layer-toggle">
          <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />
          mesh lines
        </label>
        {pec && (
          <label className="layer-toggle" title="Metal edges exactly as openEMS placed them on the grid">
            <input type="checkbox" checked={showPec} onChange={(e) => setShowPec(e.target.checked)} />
            <span className="swatch" style={{ background: "#ffb347" }} />
            metal in openEMS
          </label>
        )}
        <label className="layer-toggle" title="Stretch the board vertically so thin stack-ups are visible">
          height ×{zScale}
          <input type="range" min={1} max={20} step={1} value={zScale} onChange={(e) => setZScale(Number(e.target.value))} />
        </label>
        <button className="btn small" onClick={fit}>
          Fit
        </button>
        {children}
      </div>
      <div ref={wrap} className="view3d">
        {failed && <div className="placeholder">{failed}</div>}
      </div>
    </div>
  )
}
