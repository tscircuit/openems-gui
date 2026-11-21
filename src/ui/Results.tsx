import { useMemo, useState } from "react"
import type { SimResults } from "../lib/types"
import { LineChart, PolarChart, type Series, SmithChart, type SmithTrace } from "./Charts"
import type { JobMeta } from "./api"

const sName = (to: number, from: number, n: number) => (n > 9 ? `S${to},${from}` : `S${to}${from}`)
const mag = (re: number, im: number) => Math.hypot(re, im)
const dB = (re: number, im: number) => 20 * Math.log10(Math.max(mag(re, im), 1e-10))

export const touchstone = (r: SimResults): string | null => {
  const n = r.ports.length
  if (r.excited.length !== n) return null
  if (!r.ports.every((p) => p.R === r.ports[0].R)) return null
  const lines = [`! openEMS GUI export — ${n}-port S-parameters`, `! ports: ${r.ports.map((p) => `${p.number}=${p.name}`).join(", ")}`, `# Hz S RI R ${r.ports[0].R}`]
  for (let k = 0; k < r.freq.length; k++) {
    const cell = (i: number, j: number) => {
      const s = r.s[`${i}_${j}`]
      return `${s.re[k].toExponential(6)} ${s.im[k].toExponential(6)}`
    }
    if (n === 1) lines.push(`${r.freq[k]} ${cell(1, 1)}`)
    else if (n === 2) lines.push(`${r.freq[k]} ${cell(1, 1)} ${cell(2, 1)} ${cell(1, 2)} ${cell(2, 2)}`)
    else
      for (let i = 1; i <= n; i++) {
        const row = Array.from({ length: n }, (_, j) => cell(i, j + 1)).join(" ")
        lines.push(i === 1 ? `${r.freq[k]} ${row}` : `  ${row}`)
      }
  }
  return lines.join("\n") + "\n"
}

const download = (name: string, text: string) => {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  )
}

export function Results({ results, meta }: { results: SimResults; meta: JobMeta }) {
  const [view, setView] = useState<"db" | "phase" | "vswr">("db")
  const n = results.ports.length
  const fGHz = useMemo(() => results.freq.map((f) => f / 1e9), [results])

  const sSeries = useMemo(() => {
    const out: Series[] = []
    for (const j of results.excited)
      for (const p of results.ports) {
        const s = results.s[`${p.number}_${j}`]
        if (!s) continue
        const isRefl = p.number === j
        if (view === "vswr" && !isRefl) continue
        const y = s.re.map((re, k) => {
          const im = s.im[k]
          if (view === "db") return dB(re, im)
          if (view === "phase") return (Math.atan2(im, re) * 180) / Math.PI
          const g = Math.min(mag(re, im), 0.9999)
          return (1 + g) / (1 - g)
        })
        out.push({ id: `${p.number}_${j}`, label: sName(p.number, j, n), slot: (j - 1) * n + (p.number - 1), x: fGHz, y })
      }
    return out
  }, [results, view])

  const smith: SmithTrace[] = results.excited
    .filter((j) => results.s[`${j}_${j}`])
    .map((j) => ({
      id: `${j}`,
      label: sName(j, j, n),
      slot: (j - 1) * n + (j - 1),
      freq: results.freq,
      re: results.s[`${j}_${j}`].re,
      im: results.s[`${j}_${j}`].im,
      z0: results.ports.find((p) => p.number === j)?.R ?? 50,
    }))

  const first = results.excited[0]
  const zin = first !== undefined ? results.zin[String(first)] : undefined
  const zSeries: Series[] = zin
    ? [
        { id: "re", label: `Re Z${first}`, slot: 0, x: fGHz, y: zin.re },
        { id: "im", label: `Im Z${first}`, slot: 1, x: fGHz, y: zin.im },
      ]
    : []

  const tiles = useMemo(() => {
    const out: Array<{ label: string; value: string; sub?: string }> = []
    if (first === undefined) return out
    const s11 = results.s[`${first}_${first}`]
    if (s11) {
      const d = s11.re.map((re, k) => dB(re, s11.im[k]))
      let mi = 0
      for (let k = 1; k < d.length; k++) if (d[k] < d[mi]) mi = k
      out.push({ label: `Best match (${sName(first, first, n)})`, value: `${d[mi].toFixed(1)} dB`, sub: `at ${fGHz[mi].toFixed(3)} GHz` })
      if (d[mi] < -10) {
        let lo = mi
        let hi = mi
        while (lo > 0 && d[lo - 1] < -10) lo--
        while (hi < d.length - 1 && d[hi + 1] < -10) hi++
        const bw = fGHz[hi] - fGHz[lo]
        out.push({
          label: "−10 dB bandwidth",
          value: bw >= 1 ? `${bw.toFixed(2)} GHz` : `${(bw * 1000).toFixed(0)} MHz`,
          sub: `${fGHz[lo].toFixed(3)} – ${fGHz[hi].toFixed(3)} GHz${lo === 0 || hi === d.length - 1 ? " (band edge)" : ""}`,
        })
      }
      if (zin) out.push({ label: "Input impedance there", value: `${zin.re[mi].toFixed(1)} ${zin.im[mi] >= 0 ? "+" : "−"} j${Math.abs(zin.im[mi]).toFixed(1)} Ω` })
    }
    const through = results.ports.find((p) => p.number !== first)
    const s21 = through ? results.s[`${through.number}_${first}`] : undefined
    if (s21 && through) {
      const d = s21.re.map((re, k) => dB(re, s21.im[k]))
      const peak = Math.max(...d)
      const k3 = d.findIndex((v, k) => k > d.indexOf(peak) && v < peak - 3)
      out.push({
        label: `Peak ${sName(through.number, first, n)}`,
        value: `${peak.toFixed(2)} dB`,
        sub: k3 > 0 ? `−3 dB at ${fGHz[k3].toFixed(3)} GHz` : `at ${fGHz[d.indexOf(peak)].toFixed(3)} GHz`,
      })
    }
    const ff = results.nf2ff?.[String(first)]
    if (ff) {
      out.push({ label: "Directivity", value: `${ff.dmax_dbi.toFixed(2)} dBi`, sub: `at ${(ff.freq / 1e9).toFixed(3)} GHz` })
      if (ff.efficiency > 0 && ff.efficiency < 1.5)
        out.push({ label: "Radiation efficiency", value: `${(ff.efficiency * 100).toFixed(0)} %`, sub: `gain ${(ff.dmax_dbi + 10 * Math.log10(ff.efficiency)).toFixed(2)} dBi` })
    }
    return out
  }, [results])

  const ts = touchstone(results)
  const totalSec = results.runs.reduce((s, r) => s + r.seconds, 0)
  const partial = meta.status === "running"

  return (
    <div className="results">
      {partial && <div className="notice">Showing partial results — {results.excited.length} of {meta.progress.totalRuns} excitation runs finished.</div>}
      {meta.messages.map((m) => (
        <div key={m} className="notice warn">
          {m}
        </div>
      ))}
      <div className="tiles">
        {tiles.map((t) => (
          <Tile key={t.label} {...t} />
        ))}
        <Tile label="Solver time" value={totalSec >= 90 ? `${(totalSec / 60).toFixed(1)} min` : `${totalSec.toFixed(1)} s`} sub={`${meta.progress.cells.toLocaleString()} cells · ${results.runs.length} run${results.runs.length === 1 ? "" : "s"}`} />
      </div>

      <div className="chart-controls">
        <div className="segmented" role="tablist">
          {(
            [
              ["db", "Magnitude (dB)"],
              ["phase", "Phase (°)"],
              ["vswr", "VSWR"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={view === id ? "on" : ""} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn small" disabled={!ts} title={ts ? "" : "Excite every port (same reference impedance) to export a full S-matrix"} onClick={() => ts && download(`${meta.name.replace(/[^\w.-]+/g, "_")}.s${n}p`, ts)}>
          Touchstone .s{n}p
        </button>
        <a className="btn small" href={`/api/jobs/${meta.id}/files/results.json?download`}>
          results.json
        </a>
        <a className="btn small" href={`/api/jobs/${meta.id}/files/sim.json?download`}>
          sim.json
        </a>
        <a className="btn small" href={`/api/jobs/${meta.id}/files/geometry.xml?download`} title="CSXCAD geometry — open with AppCSXCAD">
          geometry.xml
        </a>
      </div>

      <LineChart
        title={view === "db" ? "S-parameters" : view === "phase" ? "S-parameter phase" : "VSWR"}
        series={sSeries}
        xLabel="Frequency (GHz)"
        yLabel={view === "db" ? "dB" : view === "phase" ? "degrees" : "VSWR"}
        height={320}
        yMin={view === "db" ? -60 : view === "vswr" ? 1 : undefined}
        yMax={view === "vswr" ? 10 : undefined}
        refLines={view === "db" ? [{ y: -10, label: "−10 dB" }] : view === "vswr" ? [{ y: 2, label: "2:1" }] : []}
        markers={results.nf2ff && first !== undefined && results.nf2ff[String(first)] ? [{ x: results.nf2ff[String(first)].freq / 1e9, label: "far field" }] : []}
        xFormat={(v) => v.toFixed(v < 10 ? 2 : 1)}
        yFormat={(v) => v.toFixed(view === "vswr" ? 2 : 1)}
      />

      <div className="chart-row">
        {smith.length > 0 && <SmithChart title="Smith chart" traces={smith} />}
        {zSeries.length > 0 && (
          <div className="grow">
            <LineChart title={`Input impedance, port ${first}`} series={zSeries} xLabel="Frequency (GHz)" yLabel="Ω" height={300} yMin={-500} yMax={500} xFormat={(v) => v.toFixed(2)} yFormat={(v) => v.toFixed(1)} />
          </div>
        )}
      </div>

      {results.nf2ff &&
        Object.entries(results.nf2ff).map(([port, ff]) => (
          <div className="chart-row" key={port}>
            <PolarChart
              title={`Directivity at ${(ff.freq / 1e9).toFixed(3)} GHz (dBi), port ${port}`}
              theta={ff.theta}
              cuts={[
                { id: "xz", label: "xz plane (φ = 0°)", slot: 0, values: ff.cut_xz },
                { id: "yz", label: "yz plane (φ = 90°)", slot: 1, values: ff.cut_yz },
              ]}
              size={340}
            />
            <div className="grow ff-note">
              <p>θ is measured from the board normal (+z, towards the top copper layer). θ = ±180° points out of the bottom of the board.</p>
            </div>
          </div>
        ))}

      <details className="table-view">
        <summary>Data table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>f (GHz)</th>
                {sSeries.map((s) => (
                  <th key={s.id}>
                    {s.label} ({view === "db" ? "dB" : view === "phase" ? "°" : "VSWR"})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fGHz
                .map((f, k) => k)
                .filter((k) => k % Math.max(1, Math.floor(fGHz.length / 100)) === 0)
                .map((k) => (
                  <tr key={k}>
                    <td>{fGHz[k].toFixed(4)}</td>
                    {sSeries.map((s) => (
                      <td key={s.id}>{s.y[k].toFixed(2)}</td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
