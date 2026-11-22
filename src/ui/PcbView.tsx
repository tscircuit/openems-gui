import { useEffect, useMemo, useRef, useState } from "react"
import { type Pt, pointInPolygon, polygonArea } from "../lib/geom"
import type { BuildResult, Pad, PcbModel, SimConfig } from "../lib/types"

export type Selection = { kind: "pad"; padId: string } | { kind: "point"; x: number; y: number; layer: string }

export const LAYER_COLORS: Record<string, string> = {
  top: "#d2553f",
  bottom: "#4a86d8",
  inner1: "#3fa66a",
  inner2: "#d6a02c",
  inner3: "#b06bd0",
  inner4: "#3bb5b5",
}
export const layerColor = (l: string) => LAYER_COLORS[l] ?? "#999"

interface Props {
  model: PcbModel
  config: SimConfig
  built: BuildResult
  selection: Selection | null
  pickingSecondPad: boolean
  onPick: (sel: Selection | null, pad: Pad | null) => void
}

interface View {
  x: number
  y: number
  w: number
  h: number
}

const pts = (poly: Pt[]) => poly.map((p) => `${p.x},${-p.y}`).join(" ")
const ringPath = (poly: Pt[]) => `M${poly.map((p) => `${p.x} ${-p.y}`).join("L")}Z`

export function PcbView({ model, config, built, selection, pickingSecondPad, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState<View | null>(null)
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [showMesh, setShowMesh] = useState(true)
  const [hoverPad, setHoverPad] = useState<Pad | null>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null)

  const isVisible = (l: string) => visible[l] !== false

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const extent = useMemo(() => {
    const r = built.stats?.region ?? model.board
    const m = config.marginXY
    return { minX: r.minX - m, maxX: r.maxX + m, minY: r.minY - m, maxY: r.maxY + m }
  }, [model, built.stats, config.marginXY])

  const fit = () => {
    if (size.w <= 0 || size.h <= 0) return // pane is hidden behind another tab
    const pad = 0.06
    const bw = extent.maxX - extent.minX
    const bh = extent.maxY - extent.minY
    const aspect = size.w / Math.max(1, size.h)
    let w = bw * (1 + 2 * pad)
    let h = bh * (1 + 2 * pad)
    if (w / h > aspect) h = w / aspect
    else w = h * aspect
    setView({ x: (extent.minX + extent.maxX) / 2 - w / 2, y: -(extent.minY + extent.maxY) / 2 - h / 2, w, h })
  }
  // refit when a new board is loaded, and on pane resizes until the user pans or zooms
  const userMoved = useRef(false)
  useEffect(() => {
    userMoved.current = false
  }, [model])
  useEffect(() => {
    if (!userMoved.current) fit()
  }, [model, size.w, size.h, extent.minX, extent.maxX, extent.minY, extent.maxY])

  const v = view ?? { x: extent.minX, y: -extent.maxY, w: extent.maxX - extent.minX, h: extent.maxY - extent.minY }
  // keep the aspect ratio in sync with the pane
  const vh = v.w * (size.h / Math.max(1, size.w))
  const px = v.w / Math.max(1, size.w) // world units per screen pixel

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return { x: v.x + ((e.clientX - rect.left) / rect.width) * v.w, y: -(v.y + ((e.clientY - rect.top) / rect.height) * vh) }
  }

  const padAt = (p: Pt): Pad | null => {
    let best: Pad | null = null
    let bestArea = Infinity
    for (const pad of model.pads) {
      if (!pad.layers.some(isVisible)) continue
      if (p.x < pad.bbox.minX || p.x > pad.bbox.maxX || p.y < pad.bbox.minY || p.y > pad.bbox.maxY) continue
      if (!pointInPolygon(p, pad.polygon)) continue
      const a = polygonArea(pad.polygon)
      if (a < bestArea) {
        best = pad
        bestArea = a
      }
    }
    return best
  }

  const copperLayerAt = (p: Pt): string | null => {
    for (const layer of model.layers) {
      if (!isVisible(layer)) continue
      for (const c of model.copper) {
        if (c.layer !== layer) continue
        if (p.x < c.bbox.minX || p.x > c.bbox.maxX || p.y < c.bbox.minY || p.y > c.bbox.maxY) continue
        if (pointInPolygon(p, c.polygon) && !c.holes?.some((h) => pointInPolygon(p, h))) return layer
      }
    }
    return null
  }

  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e)
    const f = Math.exp(e.deltaY * 0.0015)
    const w = Math.min(Math.max(v.w * f, 0.5), (extent.maxX - extent.minX) * 20)
    const k = w / v.w
    userMoved.current = true
    setView({ x: p.x - (p.x - v.x) * k, y: -p.y - (-p.y - v.y) * k, w, h: vh * k })
  }

  const layersBottomUp = [...model.layers].reverse()
  const copperByLayer = useMemo(() => {
    const m: Record<string, { solid: string[]; pours: string[] }> = {}
    for (const l of model.layers) m[l] = { solid: [], pours: [] }
    for (const c of model.copper) {
      const bucket = m[c.layer]
      if (!bucket) continue
      if (c.kind === "pour" || c.kind === "plane") bucket.pours.push(ringPath(c.polygon) + (c.holes ?? []).map(ringPath).join(""))
      else bucket.solid.push(ringPath(c.polygon))
    }
    return m
  }, [model])

  const mesh = built.preview?.mesh
  const meshPath = useMemo(() => {
    if (!mesh) return ""
    const x0 = mesh.x[0]
    const x1 = mesh.x[mesh.x.length - 1]
    const y0 = mesh.y[0]
    const y1 = mesh.y[mesh.y.length - 1]
    return mesh.x.map((x) => `M${x} ${-y0}V${-y1}`).join("") + mesh.y.map((y) => `M${x0} ${-y}H${x1}`).join("")
  }, [mesh])

  const selPad = selection?.kind === "pad" ? model.pads.find((p) => p.id === selection.padId) : null
  const region = built.stats?.region ?? model.board
  const r = 9 * px

  return (
    <div className="pcb-wrap">
      <div className="pcb-toolbar">
        {model.layers.map((l) => (
          <label key={l} className="layer-toggle">
            <input type="checkbox" checked={isVisible(l)} onChange={(e) => setVisible({ ...visible, [l]: e.target.checked })} />
            <span className="swatch" style={{ background: layerColor(l) }} />
            {l}
          </label>
        ))}
        <label className="layer-toggle">
          <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />
          mesh
        </label>
        <button
          className="btn small"
          onClick={() => {
            userMoved.current = false
            fit()
          }}
        >
          Fit
        </button>
        <span className="pcb-coords">
          {hoverPad ? `${hoverPad.label}${hoverPad.net ? ` · ${hoverPad.net}` : ""} · ` : ""}
          {cursor ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)} mm` : ""}
        </span>
      </div>
      <div
        ref={wrapRef}
        className={`pcb-canvas${pickingSecondPad ? " picking" : ""}`}
        onWheel={onWheel}
        onPointerDown={(e) => {
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, view: { ...v, h: vh }, moved: false }
        }}
        onPointerMove={(e) => {
          const w = toWorld(e)
          setCursor(w)
          const d = drag.current
          if (d) {
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
            if (d.moved) {
              userMoved.current = true
              setView({ ...d.view, x: d.view.x - dx * px, y: d.view.y - dy * px })
            }
          } else setHoverPad(padAt(w))
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (!d || d.moved) return
          const w = toWorld(e)
          const pad = padAt(w)
          if (pad) return onPick({ kind: "pad", padId: pad.id }, pad)
          const layer = copperLayerAt(w)
          onPick(layer ? { kind: "point", x: +w.x.toFixed(3), y: +w.y.toFixed(3), layer } : null, null)
        }}
        onPointerLeave={() => {
          setCursor(null)
          setHoverPad(null)
        }}
      >
        <svg viewBox={`${v.x} ${v.y} ${v.w} ${vh}`} width="100%" height="100%" preserveAspectRatio="none">
          {/* simulation box */}
          <rect
            x={extent.minX}
            y={-extent.maxY}
            width={extent.maxX - extent.minX}
            height={extent.maxY - extent.minY}
            className="sim-box"
            vectorEffect="non-scaling-stroke"
          />
          {/* substrate */}
          {model.board.outline ? (
            <polygon points={pts(model.board.outline)} className="substrate" />
          ) : (
            <rect x={model.board.minX} y={-model.board.maxY} width={model.board.maxX - model.board.minX} height={model.board.maxY - model.board.minY} className="substrate" />
          )}
          {config.region && (
            <rect x={region.minX} y={-region.maxY} width={region.maxX - region.minX} height={region.maxY - region.minY} className="region-box" vectorEffect="non-scaling-stroke" />
          )}
          {layersBottomUp.map((l) =>
            isVisible(l) ? (
              <g key={l} fill={layerColor(l)}>
                {config.groundPlaneLayer === l && (
                  <rect x={region.minX} y={-region.maxY} width={region.maxX - region.minX} height={region.maxY - region.minY} opacity={0.4} />
                )}
                <path d={copperByLayer[l]?.pours.join("") ?? ""} fillRule="evenodd" opacity={0.4} />
                <path d={copperByLayer[l]?.solid.join("") ?? ""} fillRule="nonzero" opacity={0.85} />
              </g>
            ) : null,
          )}
          {model.barrels.map((b) => (
            <circle key={b.id} cx={b.x} cy={-b.y} r={b.holeDiameter / 2} className="barrel" />
          ))}
          {showMesh && meshPath && <path d={meshPath} className="mesh-lines" vectorEffect="non-scaling-stroke" />}
          {/* lumped elements */}
          {built.lumped.map((el) => (
            <g key={el.name}>
              <line x1={el.start[0]} y1={-el.start[1]} x2={el.stop[0]} y2={-el.stop[1]} className="lumped-line" strokeWidth={3 * px} />
              <text x={(el.start[0] + el.stop[0]) / 2} y={-(el.start[1] + el.stop[1]) / 2 - 6 * px} fontSize={11 * px} className="lumped-label">
                {el.name}
              </text>
            </g>
          ))}
          {hoverPad && <polygon points={pts(hoverPad.polygon)} className="pad-hover" vectorEffect="non-scaling-stroke" />}
          {selPad && <polygon points={pts(selPad.polygon)} className="pad-selected" vectorEffect="non-scaling-stroke" />}
          {selection?.kind === "point" && (
            <g className="point-sel" strokeWidth={1.5 * px}>
              <line x1={selection.x - r} y1={-selection.y} x2={selection.x + r} y2={-selection.y} />
              <line x1={selection.x} y1={-selection.y - r} x2={selection.x} y2={-selection.y + r} />
            </g>
          )}
          {/* ports */}
          {built.ports.map((p) => {
            const cx = (p.start[0] + p.stop[0]) / 2
            const cy = -(p.start[1] + p.stop[1]) / 2
            return (
              <g key={p.number}>
                {p.direction !== "z" && <line x1={p.start[0]} y1={-p.start[1]} x2={p.stop[0]} y2={-p.stop[1]} className="port-line" strokeWidth={3 * px} />}
                <circle cx={cx} cy={cy} r={r} className={`port-marker${p.excite ? " excited" : ""}`} strokeWidth={1.5 * px} />
                <text x={cx} y={cy + 4 * px} fontSize={11 * px} className="port-label">
                  {p.number}
                </text>
              </g>
            )
          })}
        </svg>
        {pickingSecondPad && <div className="pick-banner">Click the second pad for this port</div>}
      </div>
    </div>
  )
}
