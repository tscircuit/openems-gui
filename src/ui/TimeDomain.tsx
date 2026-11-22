import { useMemo, useState } from "react"
import { type Spectrum, groupDelayPs, minRiseTimePs, riseTime1090Ps, stepDelayPs, stepResponse, tdrImpedance } from "../lib/timedomain"
import type { SimResults } from "../lib/types"
import { LineChart, type Series } from "./Charts"
import { Num } from "./ConfigPanel"

const sName = (to: number, from: number, n: number) => (n > 9 ? `S${to},${from}` : `S${to}${from}`)

interface Path {
  id: string
  label: string
  slot: number
  to: number
  from: number
  delay: number | null
  rise: number | null
  final: number
  peak: number
  series: Series
  through: boolean
}

export function TimeDomain({ results }: { results: SimResults }) {
  const n = results.ports.length
  const fMax = results.freq[results.freq.length - 1]
  const minRise = minRiseTimePs(fMax)
  const [rise, setRise] = useState(0)
  const riseTimePs = rise > 0 ? rise : +minRise.toFixed(0)
  const [refId, setRefId] = useState("")
  const bandStart = results.freq.length > 1 && results.freq[0] < (results.freq[1] - results.freq[0]) * 0.1 ? results.freq[1] : results.freq[0]
  const df = (fMax - bandStart) / Math.max(1, results.freq.length - 2)
  const lowBand = bandStart > 4 * df

  const { paths, tdr, gd, tMax } = useMemo(() => {
    const spec = (key: string): Spectrum | null => {
      const s = results.s[key]
      return s ? { freq: results.freq, re: s.re, im: s.im } : null
    }
    // first pass at full length to find how long the interesting part is
    const raw: Array<{ to: number; from: number; sp: Spectrum }> = []
    for (const j of results.excited) for (const p of results.ports) if (p.number !== j) {
      const sp = spec(`${p.number}_${j}`)
      if (sp) raw.push({ to: p.number, from: j, sp })
    }
    let longest = 0
    const first = raw.map((r) => {
      const resp = stepResponse(r.sp, { riseTimePs })
      const d = stepDelayPs(resp)
      if (d !== null && Math.abs(resp.final) > 0.3) longest = Math.max(longest, d)
      return resp
    })
    const tMax = Math.max(4 * riseTimePs, longest > 0 ? longest * 2.5 + 4 * riseTimePs : 2000)
    const clip = (t: number[], v: number[]) => {
      const end = t.findIndex((x) => x > tMax)
      return end < 0 ? { t, v } : { t: t.slice(0, end), v: v.slice(0, end) }
    }
    const paths: Path[] = raw.map((r, i) => {
      const resp = first[i]
      const through = Math.abs(resp.final) > 0.3
      const c = clip(resp.t, resp.v)
      let peak = 0
      for (const v of c.v) if (Math.abs(v) > Math.abs(peak)) peak = v
      const id = `${r.to}_${r.from}`
      const label = sName(r.to, r.from, n)
      return {
        id,
        label,
        slot: (r.from - 1) * n + (r.to - 1),
        to: r.to,
        from: r.from,
        delay: through ? stepDelayPs(resp) : null,
        rise: through ? riseTime1090Ps(resp) : null,
        final: resp.final,
        peak,
        through,
        series: { id, label, slot: (r.from - 1) * n + (r.to - 1), x: c.t, y: c.v },
      }
    })
    const tdr: Series[] = []
    for (const j of results.excited) {
      const sp = spec(`${j}_${j}`)
      if (!sp) continue
      const z0 = results.ports.find((p) => p.number === j)?.R ?? 50
      const z = tdrImpedance(sp, z0, { riseTimePs })
      const c = clip(z.t, z.z)
      tdr.push({ id: `${j}`, label: results.ports.find((p) => p.number === j)?.name ?? `Port ${j}`, slot: (j - 1) * n + (j - 1), x: c.t, y: c.v })
    }
    const gd: Series[] = paths
      .filter((p) => p.through)
      .map((p) => {
        const sp = spec(p.id)!
        const g = groupDelayPs(sp)
        // skip the quasi-DC sample, where the phase slope is not meaningful
        const k0 = sp.freq[0] < 1e3 ? 1 : 0
        return { id: p.id, label: p.label, slot: p.slot, x: sp.freq.slice(k0).map((f) => f / 1e9), y: g.slice(k0) }
      })
    return { paths, tdr, gd, tMax }
  }, [results, riseTimePs])

  const through = paths.filter((p) => p.through)
  const coupled = paths.filter((p) => !p.through)
  const ref = through.find((p) => p.id === refId) ?? through[0]
  const portName = (num: number) => results.ports.find((p) => p.number === num)?.name ?? `Port ${num}`
  const gdValues = gd.flatMap((s) => s.y).filter(Number.isFinite).sort((a, b) => a - b)
  const gdMed = gdValues.length ? gdValues[Math.floor(gdValues.length / 2)] : 0

  return (
    <>
      <div className="chart-controls">
        <div style={{ width: 170 }}>
          <Num label="Edge rise time (10–90 %)" unit="ps" value={riseTimePs} min={1} onChange={setRise} />
        </div>
        <p className="hint grow">
          Step responses computed from the S-parameters. This band (to {(fMax / 1e9).toFixed(1)} GHz) supports edges down to about {minRise.toFixed(0)} ps; faster edges show ripple. Simulate to a higher stop frequency
          for sharper edges.
        </p>
      </div>
      {riseTimePs < minRise * 0.95 && <div className="notice warn">The rise time is shorter than the simulated band supports ({minRise.toFixed(0)} ps): expect ringing that is not in the circuit.</div>}
      {lowBand && (
        <div className="notice warn">
          The simulated band starts at {(bandStart / 1e9).toFixed(2)} GHz, so everything below it is extrapolated. For time-domain results set the start frequency to 0.
        </div>
      )}

      {through.length > 0 && (
        <div className="chart">
          <div className="chart-head">
            <h3>Delay and skew</h3>
          </div>
          <div className="table-scroll plain">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Path</th>
                  <th>Delay (50 %)</th>
                  <th>
                    Skew vs{" "}
                    <select value={ref?.id ?? ""} onChange={(e) => setRefId(e.target.value)} aria-label="Reference path">
                      {through.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </th>
                  <th>Rise time out</th>
                  <th>Level</th>
                </tr>
              </thead>
              <tbody>
                {through.map((p) => (
                  <tr key={p.id}>
                    <td style={{ textAlign: "left" }}>
                      <b>{p.label}</b> {portName(p.from)} → {portName(p.to)}
                    </td>
                    <td>{p.delay !== null ? `${p.delay.toFixed(1)} ps` : "–"}</td>
                    <td>{p.delay !== null && ref?.delay != null ? (p.id === ref.id ? "reference" : `${p.delay - ref.delay >= 0 ? "+" : "−"}${Math.abs(p.delay - ref.delay).toFixed(1)} ps`) : "–"}</td>
                    <td>{p.rise !== null ? `${p.rise.toFixed(0)} ps` : "–"}</td>
                    <td>{(p.final * 100).toFixed(0)} %</td>
                  </tr>
                ))}
                {coupled.map((p) => (
                  <tr key={p.id}>
                    <td style={{ textAlign: "left" }}>
                      <b>{p.label}</b> {portName(p.from)} → {portName(p.to)} <span className="hint">(coupling)</span>
                    </td>
                    <td colSpan={3} style={{ textAlign: "left" }}>
                      crosstalk peak {(Math.abs(p.peak) * 100).toFixed(1)} % of the step
                    </td>
                    <td>{(p.final * 100).toFixed(0)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {paths.length > 0 && (
        <LineChart
          title="Step response (transmission)"
          series={paths.map((p) => p.series)}
          xLabel="Time (ps)"
          yLabel="V per V of step"
          height={300}
          refLines={[{ y: 0.5, label: "50 %" }]}
          xFormat={(v) => v.toFixed(0)}
          yFormat={(v) => v.toFixed(3)}
        />
      )}
      {tdr.length > 0 && (
        <LineChart
          title="TDR impedance profile"
          series={tdr}
          xLabel="Round-trip time (ps) — a feature at t is t/2 down the line"
          yLabel="Ω"
          height={280}
          yMin={Math.max(0, Math.min(...tdr.flatMap((s) => s.y), 40) - 5)}
          yMax={Math.min(200, Math.max(...tdr.flatMap((s) => s.y), 60) + 5)}
          xFormat={(v) => v.toFixed(0)}
          yFormat={(v) => v.toFixed(1)}
        />
      )}
      {gd.length > 0 && (
        <LineChart
          title="Group delay"
          series={gd}
          xLabel="Frequency (GHz)"
          yLabel="ps"
          height={260}
          yMin={Math.max(0, gdMed - Math.max(40, gdMed * 0.5))}
          yMax={gdMed + Math.max(40, gdMed * 0.5)}
          xFormat={(v) => v.toFixed(2)}
          yFormat={(v) => v.toFixed(1)}
        />
      )}
      {paths.length === 0 && tdr.length === 0 && <div className="placeholder">No S-parameters to transform.</div>}
      <p className="hint">Window shown: {tMax.toFixed(0)} ps. Delay is where the transmitted step crosses half of its final level, measured from the 50 % point of the incident edge at the driving port.</p>
    </>
  )
}
