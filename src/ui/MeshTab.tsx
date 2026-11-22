import { useEffect, useMemo, useRef, useState } from "react"
import { meshKey } from "../lib/build-sim"
import type { Boundary, BuildResult, MeshCheck, SimConfig } from "../lib/types"
import { Num } from "./ConfigPanel"
import { type PecEdges, View3D } from "./View3D"
import { api } from "./api"

const bytes = (n?: number) => (n === undefined ? "–" : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`)

interface Props {
  config: SimConfig
  setConfig: (c: SimConfig) => void
  built: BuildResult
  engineReady: boolean
}

export function MeshTab({ config, setConfig, built, engineReady }: Props) {
  const set = (patch: Partial<SimConfig>) => setConfig({ ...config, ...patch })
  const sim = built.preview
  const key = useMemo(() => (sim ? meshKey(sim) : ""), [sim])
  const [check, setCheck] = useState<MeshCheck | null>(null)
  const [pec, setPec] = useState<{ key: string; edges: PecEdges } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const started = useRef(0)

  // pick up a build that is running or finished already, and follow it while it runs
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const c = await api.mesh()
        if (cancelled) return
        setCheck(c)
        if (c.status === "running") {
          setElapsed((Date.now() - (started.current || Date.now())) / 1000)
          timer = setTimeout(tick, 400)
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, 2000)
      }
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [check?.status === "running"])

  // fetch the metal edges of a finished build
  useEffect(() => {
    if (check?.status !== "done" || !check.pec?.edges || pec?.key === check.key) return
    let cancelled = false
    api
      .meshPec()
      .then((buf) => {
        if (cancelled || !check.pec) return
        const points = new Float32Array(buf, 0, check.pec.points * 3)
        const index = new Uint32Array(buf, check.pec.points * 12, check.pec.edges * 2)
        setPec({ key: check.key, edges: { points, index } })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [check?.status, check?.key])

  const build = async () => {
    if (!sim) return
    setError(null)
    started.current = Date.now()
    setElapsed(0)
    try {
      setCheck(await api.startMesh(sim, key))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const s = built.stats
  const memMb = s ? (s.cells * 60) / 1e6 : 0
  const lambdaQuarter = 299.792458 / (((config.fStartGHz + config.fStopGHz) / 2) * 4)
  const current = check && check.key === key
  const running = check?.status === "running"
  const st = current ? check!.stats : null

  return (
    <div className="mesh-tab">
      <div className="mesh-side">
        <h3>Grid</h3>
        <div className="grid3">
          <Num label="Copper cell" unit="mm" value={config.meshRes} min={0} title="Largest cell edge in the region that contains copper" onChange={(v) => set({ meshRes: v })} />
          <Num label="Cells / λ" value={config.cellsPerWavelength} min={8} step={1} title="Cells per wavelength at the stop frequency, away from copper" onChange={(v) => set({ cellsPerWavelength: v })} />
          <Num label="Substrate cells" value={config.substrateCells} min={1} step={1} title="Cells across the substrate thickness" onChange={(v) => set({ substrateCells: Math.max(1, Math.round(v)) })} />
        </div>
        <h3>Simulation box</h3>
        <label className="field">
          <span>Boundary</span>
          <select value={config.boundary} onChange={(e) => set({ boundary: e.target.value as Boundary })}>
            <option value="PML_8">PML (8 cells) — best absorber, for antennas</option>
            <option value="MUR">Mur absorber — faster, fine for circuits</option>
            <option value="PEC">PEC — closed metal box</option>
          </select>
        </label>
        <div className="grid2">
          <Num label="Air margin, sides" unit="mm" value={config.marginXY} min={0} onChange={(v) => set({ marginXY: v })} />
          <Num label="Air margin, above/below" unit="mm" value={config.marginZ} min={0} onChange={(v) => set({ marginZ: v })} />
        </div>
        <button className="btn small" onClick={() => set({ marginXY: +lambdaQuarter.toFixed(1), marginZ: +lambdaQuarter.toFixed(1) })}>
          Set margins to λ/4 ({lambdaQuarter.toFixed(1)} mm)
        </button>

        <h3>Mesh lines</h3>
        {s ? (
          <dl className="kv">
            <dt>Lines</dt>
            <dd>
              {s.nx} × {s.ny} × {s.nz}
            </dd>
            <dt>Cells</dt>
            <dd>{s.cells.toLocaleString()}</dd>
            <dt>Smallest cell</dt>
            <dd>{s.minCell.toFixed(3)} mm</dd>
            <dt>Timestep (estimate)</dt>
            <dd>{s.estTimestepPs.toFixed(3)} ps</dd>
            <dt>Memory (estimate)</dt>
            <dd>{memMb < 1000 ? `${memMb.toFixed(0)} MB` : `${(memMb / 1000).toFixed(1)} GB`}</dd>
          </dl>
        ) : (
          <p className="hint">{built.errors[0] ?? "No mesh yet."}</p>
        )}

        <h3>
          openEMS grid
          {check && check.status === "done" && !current && <span className="badge stale">out of date</span>}
        </h3>
        <p className="hint">
          Has openEMS build its grid for this model without simulating. This is the step every run starts with, and on large boards it can take minutes; here you see how long, the exact timestep and memory,
          and where the copper actually lands on the grid.
        </p>
        {running ? (
          <div className="progress-box">
            <div className="progress-head">
              <span>Building the grid in openEMS…</span>
              <span>{elapsed.toFixed(0)} s</span>
            </div>
            <div className="progress indeterminate">
              <div />
            </div>
            <div className="progress-detail">{check!.log[check!.log.length - 1]}</div>
            <button className="btn small danger" onClick={() => api.stopMesh().then(setCheck)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn primary" disabled={!sim || !engineReady} onClick={build}>
            {check?.status === "done" && current ? "Rebuild in openEMS" : "Build mesh in openEMS"}
          </button>
        )}
        {!engineReady && <p className="hint">Needs an openEMS engine (see the engine menu, top right).</p>}
        {error && <div className="notice error">{error}</div>}
        {check?.status === "failed" && <div className="notice error">{check.error ?? "The mesh build failed."}</div>}
        {check?.status === "done" && (
          <dl className={`kv${current ? "" : " dim"}`}>
            <dt>Built in</dt>
            <dd>{(check.seconds ?? 0).toFixed(1)} s</dd>
            <dt>Cells</dt>
            <dd>
              {check.stats.cells?.toLocaleString() ?? "–"}
              {check.stats.dims ? ` (${check.stats.dims.join(" × ")})` : ""}
            </dd>
            <dt>Timestep</dt>
            <dd>{check.stats.timestepS ? `${(check.stats.timestepS * 1e12).toFixed(3)} ps` : "–"}</dd>
            <dt>Excitation pulse</dt>
            <dd>
              {check.stats.excitationTs
                ? `${check.stats.excitationTs.toLocaleString()} steps${check.stats.timestepS ? ` (${(check.stats.excitationTs * check.stats.timestepS * 1e9).toFixed(2)} ns)` : ""}`
                : "–"}
            </dd>
            <dt>Memory</dt>
            <dd>{bytes((check.stats.operatorBytes ?? 0) + (check.stats.fieldBytes ?? 0))}</dd>
            <dt>Metal edges</dt>
            <dd>{check.stats.pecEdges?.toLocaleString() ?? "–"}</dd>
          </dl>
        )}
        {st && check?.status === "done" && check.stats.pecEdges === 0 && <div className="notice warn">openEMS placed no metal on the grid. The copper is probably thinner than the cells: reduce the copper cell size.</div>}
        {check && check.log.length > 1 && (
          <details className="table-view">
            <summary>openEMS output</summary>
            <pre className="build-log">{check.log.join("\n")}</pre>
          </details>
        )}
      </div>
      {sim ? (
        <View3D sim={sim} pec={current && pec?.key === key ? pec.edges : null} meshInitially />
      ) : (
        <div className="placeholder">{built.errors[0] ?? "Nothing to mesh yet."}</div>
      )}
    </div>
  )
}
