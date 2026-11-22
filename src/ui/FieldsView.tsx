import { useEffect, useMemo, useRef, useState } from "react"
import type { FieldSet, SimInput, SimResults } from "../lib/types"
import { type FieldLayer, PATTERN_COLOR_DB, View3D, seqCss } from "./View3D"
import { api } from "./api"

const setLabel = (s: FieldSet) => (s.domain === "time" ? "E field over time" : s.quantity === "E" ? "E field (at frequency)" : "H field (at frequency)")
const nearest = (arr: number[], v: number) => {
  let best = 0
  for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i
  return best
}

/** 99.9th percentile of the field magnitude, so that the singular spot at a port does not set the scale. */
const referenceLevel = (set: FieldSet, data: Int16Array): number => {
  const vol = set.x.length * set.y.length * set.z.length
  const C = set.components
  const total = vol * set.frames.length
  const stride = Math.max(1, Math.floor(total / 400e3))
  const mags = new Float32Array(Math.ceil(total / stride))
  let n = 0
  for (let q = 0; q < total; q += stride) {
    const f = Math.floor(q / vol)
    const o = f * C * vol + (q - f * vol)
    let sum = 0
    for (let c = 0; c < C; c++) {
      const v = data[o + c * vol]
      sum += v * v
    }
    mags[n++] = Math.sqrt(sum)
  }
  const sorted = mags.subarray(0, n).sort()
  return Math.max(1, sorted[Math.min(n - 1, Math.floor(n * 0.999))])
}

export function FieldsView({ results, jobId }: { results: SimResults; jobId: string }) {
  const ports = useMemo(() => {
    const ids = new Set<string>([...Object.keys(results.fields ?? {}), ...Object.entries(results.nf2ff ?? {}).filter(([, f]) => f.pattern).map(([p]) => p)])
    return [...ids].sort((a, b) => Number(a) - Number(b))
  }, [results])
  const [port, setPort] = useState(ports[0] ?? "")
  const activePort = ports.includes(port) ? port : (ports[0] ?? "")
  const sets = results.fields?.[activePort] ?? []
  const pattern = results.nf2ff?.[activePort]?.pattern ?? null
  const [setName, setSetName] = useState("")
  const fset = sets.find((s) => s.name === setName) ?? sets[0] ?? null
  const [sim, setSim] = useState<SimInput | null>(null)
  const [loaded, setLoaded] = useState<{ file: string; data: Int16Array; ref: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [phase, setPhase] = useState(0)
  const [display, setDisplay] = useState<FieldLayer["display"]>("mag")
  const [instant, setInstant] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [rangeDb, setRangeDb] = useState(40)
  const [slices, setSlices] = useState<FieldLayer["slices"]>({ x: null, y: null, z: 0 })
  const [showPattern, setShowPattern] = useState(true)
  const [showField, setShowField] = useState(true)

  useEffect(() => {
    let cancelled = false
    setSim(null)
    api
      .jobFile<SimInput>(jobId, "sim.json")
      .then((s) => !cancelled && setSim(s))
      .catch((e) => !cancelled && setError(e?.message ?? String(e)))
    return () => {
      cancelled = true
    }
  }, [jobId])

  // load the selected field and pick sensible default slices
  useEffect(() => {
    if (!fset) return
    let cancelled = false
    setLoaded(null)
    setError(null)
    api
      .jobBinary(jobId, fset.file)
      .then((buf) => {
        if (cancelled) return
        const data = new Int16Array(buf)
        const expected = fset.frames.length * fset.components * fset.x.length * fset.y.length * fset.z.length
        if (data.length !== expected) throw new Error(`field file has ${data.length} values, expected ${expected}`)
        setLoaded({ file: fset.file, data, ref: referenceLevel(fset, data) })
      })
      .catch((e) => !cancelled && setError(`Could not load the field data: ${e?.message ?? e}`))
    setFrame(0)
    setPlaying(fset.domain === "time")
    // a travelling pulse reads best as the signed field through the board
    setDisplay(fset.domain === "time" ? "z" : "mag")
    return () => {
      cancelled = true
    }
  }, [jobId, fset?.file])

  useEffect(() => {
    if (!fset || !sim) return
    const sub = sim.substrate
    const zMid = (sub.start[2] + sub.stop[2]) / 2
    const exc = sim.ports.find((p) => String(p.number) === activePort) ?? sim.ports[0]
    setSlices({
      z: nearest(fset.z, zMid),
      y: fset.z.length > 1 && exc ? nearest(fset.y, (exc.start[1] + exc.stop[1]) / 2) : null,
      x: null,
    })
  }, [fset?.file, sim, activePort])

  // animation: phase for frequency-domain fields, frames for time-domain ones
  const raf = useRef(0)
  useEffect(() => {
    if (!playing || !fset) return
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (fset.domain === "freq") setPhase((p) => (p + dt * 2 * Math.PI * 0.5) % (2 * Math.PI))
      else {
        acc += dt * 12
        if (acc >= 1) {
          const steps = Math.floor(acc)
          acc -= steps
          setFrame((f) => (f + steps) % fset.frames.length)
        }
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, fset?.file])

  // the stored indices may still belong to the previously selected field for one render
  const clampIdx = (v: number | null, n: number) => (v === null ? null : Math.min(n - 1, Math.max(0, v)))
  const sl: FieldLayer["slices"] = fset ? { x: clampIdx(slices.x, fset.x.length), y: clampIdx(slices.y, fset.y.length), z: clampIdx(slices.z, fset.z.length) } : slices
  const patternMax = useMemo(() => (pattern ? Math.max(...pattern.d_dbi.map((row) => Math.max(...row))) : 0), [pattern])
  const isFreq = fset?.domain === "freq"
  const useInstant = isFreq ? instant || playing : true
  const layer: FieldLayer | null = useMemo(
    () => (fset && loaded && loaded.file === fset.file && showField ? { set: fset, data: loaded.data, frame, phase, display, instant: useInstant, rangeDb, ref: loaded.ref, slices: sl } : null),
    [fset, loaded, frame, phase, display, useInstant, rangeDb, sl.x, sl.y, sl.z, showField],
  )

  if (ports.length === 0)
    return (
      <div className="placeholder">
        This run has no recorded fields. In the sidebar, open <b>Fields &amp; far field</b>, tick <i>Record fields at set frequencies</i> or <i>Record the E field over time</i> (or <i>Compute far field</i> for an
        antenna), and run again.
      </div>
    )
  if (!sim) return <div className="placeholder">{error ?? "Loading the model…"}</div>

  const fr = fset?.frames[Math.min(frame, (fset?.frames.length ?? 1) - 1)]
  const frameLabel = fr ? (fr.f !== undefined ? `${(fr.f / 1e9).toFixed(3)} GHz` : `${((fr.t ?? 0) * 1e12).toFixed(0)} ps`) : ""
  const sliceRow = (axis: "x" | "y" | "z", coords: number[], label: string) => {
    const v = sl[axis]
    if (axis !== "z" && (fset?.z.length ?? 1) < 2) return null
    return (
      <label className="slice-row" key={axis}>
        <input type="checkbox" checked={v !== null} onChange={(e) => setSlices({ ...slices, [axis]: e.target.checked ? Math.floor(coords.length / 2) : null })} />
        <span>{label}</span>
        <input type="range" min={0} max={coords.length - 1} value={v ?? 0} disabled={v === null || coords.length < 2} onChange={(e) => setSlices({ ...slices, [axis]: Number(e.target.value) })} />
        <em>{v !== null ? `${axis} = ${coords[v].toFixed(2)} mm` : "off"}</em>
      </label>
    )
  }

  return (
    <div className="fields-view">
      <View3D sim={sim} field={layer} pattern={showPattern ? pattern : null}>
        {fset && <span className="pcb-coords">{frameLabel}</span>}
      </View3D>
      <div className="fields-side">
        {ports.length > 1 && (
          <label className="field">
            <span>Excited port</span>
            <select value={activePort} onChange={(e) => setPort(e.target.value)}>
              {ports.map((p) => (
                <option key={p} value={p}>
                  Port {p}
                </option>
              ))}
            </select>
          </label>
        )}
        {pattern && (
          <label className="check">
            <input type="checkbox" checked={showPattern} onChange={(e) => setShowPattern(e.target.checked)} />
            Antenna pattern
          </label>
        )}
        {pattern && showPattern && (
          <>
            <div className="colorbar">
              <div style={{ background: `linear-gradient(to right, ${[0.15, 0.32, 0.49, 0.66, 0.83, 1].map(seqCss).join(",")})` }} />
              <span>{(patternMax - PATTERN_COLOR_DB).toFixed(1)} dBi</span>
              <span>{patternMax.toFixed(1)} dBi</span>
            </div>
            <p className="hint">
              Directivity at {((results.nf2ff?.[activePort]?.freq ?? 0) / 1e9).toFixed(3)} GHz. The distance from the board centre is linear in dB over 30 dB. Axes: x red, y green, z blue (z is the board normal, θ = 0).
            </p>
          </>
        )}
        {fset ? (
          <>
            <label className="check">
              <input type="checkbox" checked={showField} onChange={(e) => setShowField(e.target.checked)} />
              Field slices
            </label>
            <label className="field">
              <span>Field</span>
              <select value={fset.name} onChange={(e) => setSetName(e.target.value)}>
                {sets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {setLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            {isFreq ? (
              <label className="field">
                <span>Frequency</span>
                <select value={frame} onChange={(e) => setFrame(Number(e.target.value))}>
                  {fset.frames.map((f, i) => (
                    <option key={i} value={i}>
                      {((f.f ?? 0) / 1e9).toFixed(3)} GHz
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span>Time — {frameLabel}</span>
                <input
                  type="range"
                  min={0}
                  max={fset.frames.length - 1}
                  value={frame}
                  onChange={(e) => {
                    setPlaying(false)
                    setFrame(Number(e.target.value))
                  }}
                />
              </label>
            )}
            <div className="port-row">
              <button className="btn small" onClick={() => setPlaying(!playing)}>
                {playing ? "❚❚ Pause" : "▶ Animate"}
              </button>
              {isFreq && !playing && (
                <label className="check" title="Show the field at one instant of the cycle instead of its peak value">
                  <input type="checkbox" checked={instant} onChange={(e) => setInstant(e.target.checked)} />
                  one instant
                </label>
              )}
            </div>
            <label className="field">
              <span>Show</span>
              <select value={display} onChange={(e) => setDisplay(e.target.value as FieldLayer["display"])}>
                <option value="mag">Magnitude |{fset.quantity}|</option>
                <option value="x">{fset.quantity}x</option>
                <option value="y">{fset.quantity}y</option>
                <option value="z">{fset.quantity}z (through the board)</option>
              </select>
            </label>
            <label className="field">
              <span>Colour range — {rangeDb} dB</span>
              <input type="range" min={10} max={80} step={5} value={rangeDb} onChange={(e) => setRangeDb(Number(e.target.value))} />
            </label>
            <div className="colorbar">
              <div style={{ background: `linear-gradient(to right, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map(seqCss).join(",")})` }} />
              <span>−{rangeDb} dB</span>
              <span>0 dB</span>
            </div>
            <p className="hint">
              Relative to the strongest field in the recording (99.9th percentile). {display !== "mag" && useInstant ? "Signed components are drawn red (+) and blue (−). " : ""}
              {isFreq ? "Animating sweeps the phase over one cycle." : "The pulse is the simulation's Gaussian excitation."}
            </p>
            <h3>Slices</h3>
            {sliceRow("z", fset.z, "Horizontal")}
            {sliceRow("y", fset.y, "Along x")}
            {sliceRow("x", fset.x, "Along y")}
            <p className="hint">
              {fset.x.length} × {fset.y.length} × {fset.z.length} points{fset.domain === "time" ? `, ${fset.frames.length} frames` : ""}.
            </p>
            {error && <div className="notice error">{error}</div>}
            {!loaded && !error && <p className="hint">Loading field data…</p>}
          </>
        ) : (
          <p className="hint">No fields were recorded for this port; only the far-field pattern is available.</p>
        )}
      </div>
    </div>
  )
}
