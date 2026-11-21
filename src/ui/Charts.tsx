import { useEffect, useMemo, useRef, useState } from "react"

export interface Series {
  id: string
  label: string
  /** 0-based slot in the fixed categorical order */
  slot: number
  x: number[]
  y: number[]
}

export const seriesColor = (slot: number) => `var(--series-${(slot % 8) + 1})`
/** Slots past the 8-hue palette repeat a hue with a dash pattern as secondary encoding. */
export const seriesDash = (slot: number) => (slot >= 16 ? "2 3" : slot >= 8 ? "6 4" : undefined)

const niceTicks = (min: number, max: number, target: number): number[] => {
  if (!(max > min)) return [min]
  const raw = (max - min) / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12))
  return out
}

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function Legend({ series, hidden, onToggle }: { series: Series[]; hidden: Set<string>; onToggle: (id: string) => void }) {
  if (series.length < 2) return null
  return (
    <div className="legend">
      {series.map((s) => (
        <button key={s.id} className={`legend-item${hidden.has(s.id) ? " off" : ""}`} onClick={() => onToggle(s.id)} title="Show / hide">
          <svg width="18" height="8" aria-hidden>
            <line x1="0" y1="4" x2="18" y2="4" stroke={seriesColor(s.slot)} strokeWidth="2" strokeDasharray={seriesDash(s.slot)} />
          </svg>
          {s.label}
        </button>
      ))}
    </div>
  )
}

interface LineChartProps {
  title: string
  series: Series[]
  xLabel: string
  yLabel: string
  height?: number
  yMin?: number
  yMax?: number
  /** dashed horizontal reference lines */
  refLines?: Array<{ y: number; label: string }>
  /** vertical markers */
  markers?: Array<{ x: number; label: string }>
  xFormat?: (v: number) => string
  yFormat?: (v: number) => string
}

export function LineChart({ title, series, xLabel, yLabel, height = 280, yMin, yMax, refLines = [], markers = [], xFormat, yFormat }: LineChartProps) {
  const [ref, width] = useWidth()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<number | null>(null)
  const shown = series.filter((s) => !hidden.has(s.id))
  const m = { l: 52, r: 16, t: 10, b: 34 }
  const iw = Math.max(50, width - m.l - m.r)
  const ih = height - m.t - m.b
  const fx = xFormat ?? ((v: number) => String(+v.toPrecision(4)))
  const fy = yFormat ?? ((v: number) => String(+v.toPrecision(4)))

  const dom = useMemo(() => {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const s of shown.length ? shown : series) {
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) continue
        x0 = Math.min(x0, s.x[i])
        x1 = Math.max(x1, s.x[i])
        y0 = Math.min(y0, s.y[i])
        y1 = Math.max(y1, s.y[i])
      }
    }
    if (!Number.isFinite(x0)) return { x0: 0, x1: 1, y0: 0, y1: 1 }
    if (yMin !== undefined) y0 = Math.max(y0, yMin)
    if (yMax !== undefined) y1 = Math.min(Math.max(y1, y0 + 1e-9), yMax)
    const pad = (y1 - y0) * 0.06 || 1
    return { x0, x1, y0: yMin !== undefined && y0 <= yMin ? yMin : y0 - pad, y1: yMax !== undefined && y1 >= yMax ? yMax : y1 + pad }
  }, [series, hidden, yMin, yMax])

  const yTicks = niceTicks(dom.y0, dom.y1, Math.max(3, Math.round(ih / 48)))
  const xTicks = niceTicks(dom.x0, dom.x1, Math.max(3, Math.round(iw / 90)))
  const sx = (x: number) => m.l + ((x - dom.x0) / (dom.x1 - dom.x0 || 1)) * iw
  const sy = (y: number) => m.t + (1 - (Math.min(Math.max(y, dom.y0), dom.y1) - dom.y0) / (dom.y1 - dom.y0 || 1)) * ih

  const paths = useMemo(
    () =>
      shown.map((s) => {
        let d = ""
        let pen = false
        for (let i = 0; i < s.x.length; i++) {
          if (!Number.isFinite(s.y[i])) {
            pen = false
            continue
          }
          d += `${pen ? "L" : "M"}${sx(s.x[i]).toFixed(1)} ${sy(s.y[i]).toFixed(1)}`
          pen = true
        }
        return { s, d }
      }),
    [shown.map((s) => s.id).join(), series, dom, iw, ih],
  )

  const base = series[0]
  const hoverX = hover !== null && base ? base.x[hover] : null
  const onMove = (e: React.PointerEvent) => {
    if (!base) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = dom.x0 + ((e.clientX - rect.left - m.l) / iw) * (dom.x1 - dom.x0)
    let lo = 0
    let hi = base.x.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (base.x[mid] < x) lo = mid
      else hi = mid
    }
    setHover(Math.abs(base.x[lo] - x) < Math.abs(base.x[hi] - x) ? lo : hi)
  }

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <h3>{title}</h3>
        <Legend
          series={series}
          hidden={hidden}
          onToggle={(id) => {
            const n = new Set(hidden)
            n.has(id) ? n.delete(id) : n.add(id)
            setHidden(n)
          }}
        />
      </div>
      <div className="chart-body" style={{ height }}>
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} className="grid" />
              <text x={m.l - 8} y={sy(t) + 4} textAnchor="end" className="tick">
                {fy(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + ih} className="grid" />
              <text x={sx(t)} y={m.t + ih + 16} textAnchor="middle" className="tick">
                {fx(t)}
              </text>
            </g>
          ))}
          <line x1={m.l} x2={m.l + iw} y1={m.t + ih} y2={m.t + ih} className="axis" />
          <text x={m.l + iw / 2} y={height - 3} textAnchor="middle" className="axis-label">
            {xLabel}
          </text>
          <text transform={`translate(12 ${m.t + ih / 2}) rotate(-90)`} textAnchor="middle" className="axis-label">
            {yLabel}
          </text>
          {refLines
            .filter((r) => r.y > dom.y0 && r.y < dom.y1)
            .map((r) => (
              <g key={r.label}>
                <line x1={m.l} x2={m.l + iw} y1={sy(r.y)} y2={sy(r.y)} className="ref-line" />
                <text x={m.l + iw - 4} y={sy(r.y) - 4} textAnchor="end" className="tick">
                  {r.label}
                </text>
              </g>
            ))}
          {markers
            .filter((k) => k.x >= dom.x0 && k.x <= dom.x1)
            .map((k) => (
              <g key={k.label}>
                <line x1={sx(k.x)} x2={sx(k.x)} y1={m.t} y2={m.t + ih} className="ref-line" />
                <text x={sx(k.x) + 4} y={m.t + 11} className="tick">
                  {k.label}
                </text>
              </g>
            ))}
          {paths.map(({ s, d }) => (
            <path key={s.id} d={d} fill="none" stroke={seriesColor(s.slot)} strokeWidth={2} strokeDasharray={seriesDash(s.slot)} strokeLinejoin="round" />
          ))}
          {hoverX !== null && (
            <g pointerEvents="none">
              <line x1={sx(hoverX)} x2={sx(hoverX)} y1={m.t} y2={m.t + ih} className="crosshair" />
              {shown.map((s) =>
                Number.isFinite(s.y[hover!]) && s.y[hover!] >= dom.y0 && s.y[hover!] <= dom.y1 ? (
                  <circle key={s.id} cx={sx(hoverX)} cy={sy(s.y[hover!])} r={4} fill={seriesColor(s.slot)} className="hover-dot" />
                ) : null,
              )}
            </g>
          )}
        </svg>
        {hoverX !== null && shown.length > 0 && (
          <div className="tooltip" style={sx(hoverX) > width / 2 ? { right: width - sx(hoverX) + 12 } : { left: sx(hoverX) + 12 }}>
            <div className="tooltip-title">
              {fx(hoverX)} {xLabel.replace(/^.*\(|\)$/g, "")}
            </div>
            {shown.map((s) => (
              <div key={s.id} className="tooltip-row">
                <span className="dot" style={{ background: seriesColor(s.slot) }} />
                <span>{s.label}</span>
                <b>{Number.isFinite(s.y[hover!]) ? fy(s.y[hover!]) : "–"}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export interface SmithTrace {
  id: string
  label: string
  slot: number
  freq: number[]
  re: number[]
  im: number[]
  z0: number
}

export function SmithChart({ title, traces, size = 300 }: { title: string; traces: SmithTrace[]; size?: number }) {
  const [hover, setHover] = useState<{ t: number; i: number } | null>(null)
  const R = size / 2 - 14
  const c = size / 2
  const gx = (re: number) => c + re * R
  const gy = (im: number) => c - im * R
  const rCircles = [0, 0.2, 0.5, 1, 2, 5]
  const xArcs = [0.2, 0.5, 1, 2, 5]
  const onMove = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const re = (e.clientX - rect.left - c) / R
    const im = -(e.clientY - rect.top - c) / R
    let best: { t: number; i: number } | null = null
    let bd = 0.02
    traces.forEach((tr, t) => {
      for (let i = 0; i < tr.re.length; i++) {
        const d = (tr.re[i] - re) ** 2 + (tr.im[i] - im) ** 2
        if (d < bd) {
          bd = d
          best = { t, i }
        }
      }
    })
    setHover(best)
  }
  const h = hover ? traces[hover.t] : null
  let tip: { f: number; zr: number; zi: number; x: number; y: number } | null = null
  if (h && hover) {
    const gr = h.re[hover.i]
    const gi = h.im[hover.i]
    const den = (1 - gr) ** 2 + gi ** 2 || 1e-12
    tip = { f: h.freq[hover.i], zr: (h.z0 * (1 - gr * gr - gi * gi)) / den, zi: (h.z0 * 2 * gi) / den, x: gx(gr), y: gy(gi) }
  }
  return (
    <div className="chart smith">
      <div className="chart-head">
        <h3>{title}</h3>
        {traces.length > 1 && (
          <div className="legend">
            {traces.map((t) => (
              <span key={t.id} className="legend-item static">
                <svg width="18" height="8" aria-hidden>
                  <line x1="0" y1="4" x2="18" y2="4" stroke={seriesColor(t.slot)} strokeWidth="2" strokeDasharray={seriesDash(t.slot)} />
                </svg>
                {t.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="chart-body" style={{ width: size, height: size }}>
        <svg width={size} height={size} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
          <defs>
            <clipPath id="smith-clip">
              <circle cx={c} cy={c} r={R} />
            </clipPath>
          </defs>
          <g clipPath="url(#smith-clip)" fill="none" className="smith-grid">
            {rCircles.map((r) => (
              <circle key={`r${r}`} cx={gx(r / (1 + r))} cy={c} r={R / (1 + r)} />
            ))}
            {xArcs.map((x) => (
              <g key={`x${x}`}>
                <circle cx={gx(1)} cy={gy(1 / x)} r={R / x} />
                <circle cx={gx(1)} cy={gy(-1 / x)} r={R / x} />
              </g>
            ))}
            <line x1={gx(-1)} y1={c} x2={gx(1)} y2={c} />
          </g>
          <circle cx={c} cy={c} r={R} fill="none" className="axis" />
          {traces.map((t) => (
            <path
              key={t.id}
              d={t.re.map((re, i) => `${i ? "L" : "M"}${gx(re).toFixed(1)} ${gy(t.im[i]).toFixed(1)}`).join("")}
              fill="none"
              stroke={seriesColor(t.slot)}
              strokeWidth={2}
              strokeDasharray={seriesDash(t.slot)}
              clipPath="url(#smith-clip)"
            />
          ))}
          {traces.map((t) => (
            <circle key={`s${t.id}`} cx={gx(t.re[0])} cy={gy(t.im[0])} r={4} fill={seriesColor(t.slot)} className="hover-dot">
              <title>{`${t.label} start`}</title>
            </circle>
          ))}
          {tip && h && <circle cx={tip.x} cy={tip.y} r={5} fill={seriesColor(h.slot)} className="hover-dot" pointerEvents="none" />}
        </svg>
        {tip && h && (
          <div className="tooltip" style={tip.x > size / 2 ? { right: size - tip.x + 12, top: tip.y } : { left: tip.x + 12, top: tip.y }}>
            <div className="tooltip-title">
              {h.label} · {(tip.f / 1e9).toFixed(3)} GHz
            </div>
            <div className="tooltip-row">
              <span>Z</span>
              <b>
                {tip.zr.toFixed(1)} {tip.zi >= 0 ? "+" : "−"} j{Math.abs(tip.zi).toFixed(1)} Ω
              </b>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function PolarChart({
  title,
  theta,
  cuts,
  size = 300,
  span = 40,
}: {
  title: string
  theta: number[]
  cuts: Array<{ id: string; label: string; slot: number; values: number[] }>
  size?: number
  span?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const c = size / 2
  const R = size / 2 - 22
  const max = Math.ceil(Math.max(...cuts.flatMap((k) => k.values)) / 5) * 5
  const min = max - span
  const rad = (v: number) => (Math.max(v, min) - min) / span
  const pos = (thDeg: number, v: number) => {
    const a = (thDeg * Math.PI) / 180
    return [c + Math.sin(a) * rad(v) * R, c - Math.cos(a) * rad(v) * R] as const
  }
  const rings = [0, 10, 20, 30].filter((d) => d < span)
  const onMove = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - rect.left - c
    const dy = -(e.clientY - rect.top - c)
    if (Math.hypot(dx, dy) > R + 10) return setHover(null)
    const ang = (Math.atan2(dx, dy) * 180) / Math.PI
    let bi = 0
    for (let i = 0; i < theta.length; i++) if (Math.abs(theta[i] - ang) < Math.abs(theta[bi] - ang)) bi = i
    setHover(bi)
  }
  return (
    <div className="chart smith">
      <div className="chart-head">
        <h3>{title}</h3>
        <div className="legend">
          {cuts.map((k) => (
            <span key={k.id} className="legend-item static">
              <svg width="18" height="8" aria-hidden>
                <line x1="0" y1="4" x2="18" y2="4" stroke={seriesColor(k.slot)} strokeWidth="2" />
              </svg>
              {k.label}
            </span>
          ))}
        </div>
      </div>
      <div className="chart-body" style={{ width: size, height: size }}>
        <svg width={size} height={size} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
          {rings.map((d) => (
            <g key={d}>
              <circle cx={c} cy={c} r={((span - d) / span) * R} fill="none" className={d === 0 ? "axis" : "grid"} />
              <text x={c + 3} y={c - ((span - d) / span) * R + 11} className="tick">
                {max - d}
              </text>
            </g>
          ))}
          {[0, 30, 60, 90, 120, 150].map((a) => {
            const s = Math.sin((a * Math.PI) / 180) * R
            const k = Math.cos((a * Math.PI) / 180) * R
            return <line key={a} x1={c - s} y1={c + k} x2={c + s} y2={c - k} className="grid" />
          })}
          {[0, 90, 180, -90].map((a) => {
            const s = Math.sin((a * Math.PI) / 180) * (R + 12)
            const k = Math.cos((a * Math.PI) / 180) * (R + 12)
            return (
              <text key={a} x={c + s} y={c - k + 4} textAnchor="middle" className="tick">
                {a}°
              </text>
            )
          })}
          {cuts.map((k) => (
            <path
              key={k.id}
              d={theta.map((t, i) => `${i ? "L" : "M"}${pos(t, k.values[i]).map((n) => n.toFixed(1)).join(" ")}`).join("") + "Z"}
              fill="none"
              stroke={seriesColor(k.slot)}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ))}
          {hover !== null &&
            cuts.map((k) => {
              const [x, y] = pos(theta[hover], k.values[hover])
              return <circle key={k.id} cx={x} cy={y} r={4} fill={seriesColor(k.slot)} className="hover-dot" pointerEvents="none" />
            })}
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: 8, top: 8 }}>
            <div className="tooltip-title">θ = {theta[hover]}°</div>
            {cuts.map((k) => (
              <div key={k.id} className="tooltip-row">
                <span className="dot" style={{ background: seriesColor(k.slot) }} />
                <span>{k.label}</span>
                <b>{k.values[hover].toFixed(1)} dBi</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
