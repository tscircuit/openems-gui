import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { buildSimulation, defaultConfig } from "../lib/build-sim"
import { EXAMPLES } from "../lib/examples"
import { extractPcbModel, normalizeCircuitJson } from "../lib/extract"
import type { Pad, PcbModel, SimConfig, SimResults } from "../lib/types"
import { ConfigPanel, addLateralPort } from "./ConfigPanel"
import { EnginePanel } from "./EnginePanel"
import { MeshTab } from "./MeshTab"
import { PcbView, type Selection } from "./PcbView"
import { Results } from "./Results"
import { type EngineInfo, type JobMeta, api } from "./api"

interface Doc {
  name: string
  json: any[]
  model: PcbModel
}

interface JobState {
  meta: JobMeta
  log: string[]
  results: SimResults | null
}

const timeAgo = (t: number) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString()
}

export function App() {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [config, setConfig] = useState<SimConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [pickingSecondPad, setPickingSecondPad] = useState(false)
  const [tab, setTab] = useState<"board" | "mesh" | "results" | "log">("board")
  const [engine, setEngine] = useState<EngineInfo | null>(null)
  const [showEngine, setShowEngine] = useState(false)
  const [jobs, setJobs] = useState<JobMeta[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const autoShowResults = useRef<string | null>(null)

  const deferredConfig = useDeferredValue(config)
  const built = useMemo(() => (doc && deferredConfig ? buildSimulation(doc.model, deferredConfig) : null), [doc, deferredConfig])

  const loadCircuit = useCallback((name: string, data: unknown, configure?: (c: SimConfig, m: PcbModel) => SimConfig, savedConfig?: SimConfig) => {
    try {
      const json = normalizeCircuitJson(data)
      const model = extractPcbModel(json)
      const base = defaultConfig(model)
      setDoc({ name, json, model })
      setConfig(savedConfig ? { ...base, ...savedConfig } : configure ? configure(base, model) : base)
      setSelection(null)
      setPickingSecondPad(false)
      setLoadError(null)
      setTab("board")
    } catch (e: any) {
      setLoadError(`${name}: ${e?.message ?? e}`)
    }
  }, [])

  const loadFile = useCallback(
    async (file: File) => {
      try {
        loadCircuit(file.name, JSON.parse(await file.text()))
      } catch (e: any) {
        setLoadError(`${file.name}: not valid JSON (${e?.message ?? e})`)
      }
    },
    [loadCircuit],
  )

  const loadExample = async (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)
    if (!ex) return
    try {
      loadCircuit(ex.file, await api.example(id), ex.configure)
    } catch (e: any) {
      setLoadError(e?.message ?? String(e))
    }
  }

  const refreshJobs = useCallback(() => api.jobs().then(setJobs).catch(() => {}), [])
  const refreshEngine = useCallback(() => api.engine().then(setEngine).catch(() => setEngine(null)), [])

  useEffect(() => {
    refreshEngine()
    refreshJobs()
  }, [])
  const engineBusy = !!engine && (engine.docker.build.running || ["downloading", "verifying", "extracting"].includes(engine.download.state))
  useEffect(() => {
    if (!engine || (engine.mode !== "none" && !engineBusy && !showEngine)) return
    const t = setInterval(refreshEngine, engineBusy ? 700 : 2500)
    return () => clearInterval(t)
  }, [engine?.mode, engineBusy, showEngine])
  // offer the engine panel straight away when nothing can run simulations yet
  useEffect(() => {
    if (engine?.mode === "none") setShowEngine(true)
  }, [engine?.mode === "none"])

  // ---- job polling ----
  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    let since = 0
    let rv = 0
    let timer: ReturnType<typeof setTimeout>
    setJob(null)
    const tick = async () => {
      try {
        const r = await api.job(activeJobId, since)
        if (cancelled) return
        const fresh = since === 0
        since = r.logLength
        setJob((prev) => ({ meta: r.meta, log: fresh || !prev ? r.log : [...prev.log, ...r.log], results: fresh ? null : (prev?.results ?? null) }))
        if (r.meta.resultsVersion > rv) {
          rv = r.meta.resultsVersion
          const res = await api.results(activeJobId).catch(() => null)
          if (!cancelled && res) {
            setJob((prev) => (prev ? { ...prev, results: res } : prev))
            if (autoShowResults.current === activeJobId) {
              autoShowResults.current = null
              setTab("results")
            }
          }
        }
        if (r.meta.status === "running") timer = setTimeout(tick, 600)
        else refreshJobs()
      } catch {
        if (!cancelled) timer = setTimeout(tick, 2000)
      }
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeJobId])

  useEffect(() => {
    const el = logRef.current
    if (el && tab === "log") el.scrollTop = el.scrollHeight
  }, [job?.log.length, tab])

  const running = job?.meta.status === "running"

  const run = async () => {
    if (!doc || !config) return
    const fresh = buildSimulation(doc.model, config)
    if (!fresh.input) return
    setRunError(null)
    try {
      const meta = await api.startJob({
        name: `${doc.name.replace(/\.circuit\.json$|\.json$/, "")}`,
        circuitName: doc.name,
        sim: fresh.input,
        config,
        circuitJson: doc.json,
      })
      autoShowResults.current = meta.id
      setActiveJobId(meta.id)
      setTab("log")
      refreshJobs()
    } catch (e: any) {
      setRunError(e?.message ?? String(e))
    }
  }

  const restoreSetup = async (id: string) => {
    try {
      const [circuitJson, cfg] = await Promise.all([api.jobFile<unknown>(id, "circuit.json"), api.jobFile<SimConfig>(id, "config.json")])
      const meta = jobs.find((j) => j.id === id)
      loadCircuit(meta?.circuitName || id, circuitJson, undefined, cfg)
    } catch (e: any) {
      setLoadError(`Could not restore setup: ${e?.message ?? e}`)
    }
  }

  const onPick = (sel: Selection | null, pad: Pad | null) => {
    if (pickingSecondPad && doc && config) {
      const first = selection?.kind === "pad" ? doc.model.pads.find((p) => p.id === selection.padId) : null
      if (first && pad && pad.id !== first.id) {
        setConfig(addLateralPort(config, first, pad))
        setPickingSecondPad(false)
        setSelection(null)
        return
      }
      if (!pad) setPickingSecondPad(false)
      return
    }
    setSelection(sel)
  }

  const p = job?.meta.progress
  const frac = p
    ? Math.min(
        1,
        (Math.max(0, p.run - 1) +
          Math.max(p.timestep / Math.max(1, p.maxTimesteps), p.energyDb !== null && p.endCriteriaDb < 0 ? Math.min(1, Math.max(0, p.energyDb / p.endCriteriaDb)) : 0)) /
          Math.max(1, p.totalRuns),
      )
    : 0

  const warnings = [...(doc?.model.warnings ?? []), ...(built?.warnings ?? [])]
  const errors = built?.errors ?? []
  const canRun = !!built?.input && engine?.mode !== "none" && !!engine && !running

  return (
    <div
      className={`app${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const f = e.dataTransfer.files[0]
        if (f) loadFile(f)
      }}
    >
      <header className="topbar">
        <div className="brand">
          openEMS <span>GUI</span>
        </div>
        {doc && <div className="doc-name" title={doc.name}>{doc.name}</div>}
        <button className="btn" onClick={() => fileInput.current?.click()}>
          Open Circuit JSON…
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
        <details className="menu">
          <summary className="btn">Examples</summary>
          <div className="menu-pop">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.id}
                className="menu-item"
                onClick={(e) => {
                  ;(e.currentTarget.closest("details") as HTMLDetailsElement).open = false
                  loadExample(ex.id)
                }}
              >
                <b>{ex.title}</b>
                <span>{ex.description}</span>
              </button>
            ))}
          </div>
        </details>
        <div className="spacer" />
        <details className="menu right">
          <summary className="btn">Runs{jobs.length ? ` (${jobs.length})` : ""}</summary>
          <div className="menu-pop">
            {jobs.length === 0 && <div className="menu-empty">No simulations yet.</div>}
            {jobs.map((j) => (
              <div key={j.id} className={`menu-item job${j.id === activeJobId ? " active" : ""}`}>
                <button
                  className="job-main"
                  onClick={async (e) => {
                    ;(e.currentTarget.closest("details") as HTMLDetailsElement).open = false
                    // with no board open there is nowhere to show the run: bring its board back first
                    if (!doc) await restoreSetup(j.id)
                    setActiveJobId(j.id)
                    setTab(j.resultsVersion > 0 ? "results" : "log")
                  }}
                >
                  <b>{j.name}</b>
                  <span>
                    <i className={`status ${j.status}`} /> {j.status} · {timeAgo(j.createdAt)} · {j.progress.cells.toLocaleString()} cells
                  </span>
                </button>
                <button className="icon-btn" title="Load this run's board and settings" onClick={() => restoreSetup(j.id)}>
                  ↺
                </button>
                <button
                  className="icon-btn"
                  title="Delete run"
                  onClick={async () => {
                    await api.deleteJob(j.id).catch(() => {})
                    if (activeJobId === j.id) {
                      setActiveJobId(null)
                      setJob(null)
                    }
                    refreshJobs()
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </details>
        <button className={`engine-pill ${engine?.mode ?? "none"}`} onClick={() => setShowEngine(!showEngine)} title="openEMS engine">
          <i />
          {engine ? (engineBusy ? "Setting up openEMS…" : engine.label) : "Checking engine…"}
        </button>
      </header>

      {showEngine && engine && <EnginePanel engine={engine} refresh={refreshEngine} onClose={() => setShowEngine(false)} />}

      {loadError && (
        <div className="notice error banner">
          {loadError}
          <button className="icon-btn" onClick={() => setLoadError(null)}>
            ×
          </button>
        </div>
      )}

      {!doc || !config || !built ? (
        <main className="empty">
          <div className="dropzone" onClick={() => fileInput.current?.click()}>
            <h1>Drop a Circuit JSON file here</h1>
            <p>
              or click to choose one. The PCB copper, stack-up and components are converted into an openEMS FDTD model that you can configure and run from this page.
            </p>
          </div>
          <h2>Or start from an example</h2>
          <div className="example-cards">
            {EXAMPLES.map((ex) => (
              <button key={ex.id} className="example-card" onClick={() => loadExample(ex.id)}>
                <b>{ex.title}</b>
                <span>{ex.description}</span>
              </button>
            ))}
          </div>
        </main>
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <div className="board-summary">
              {(doc.model.board.maxX - doc.model.board.minX).toFixed(1)} × {(doc.model.board.maxY - doc.model.board.minY).toFixed(1)} mm · {doc.model.layers.length} layers · {doc.model.pads.length} pads ·{" "}
              {doc.model.copper.filter((c) => c.kind === "trace").length} trace segments · {doc.model.barrels.length} vias/holes
            </div>
            <ConfigPanel model={doc.model} config={config} setConfig={setConfig} built={built} selection={selection} pickingSecondPad={pickingSecondPad} setPickingSecondPad={setPickingSecondPad} openMesh={() => setTab("mesh")} />
            <div className="runbar">
              {errors.map((e) => (
                <div key={e} className="notice error">
                  {e}
                </div>
              ))}
              {warnings.map((w) => (
                <div key={w} className="notice warn">
                  {w}
                </div>
              ))}
              {runError && <div className="notice error">{runError}</div>}
              {engine?.mode === "none" && (
                <div className="notice warn">
                  No openEMS engine found.{" "}
                  <button className="link" onClick={() => setShowEngine(true)}>
                    Set up the engine
                  </button>
                </div>
              )}
              {running && p ? (
                <div className="progress-box">
                  <div className="progress-head">
                    <span>
                      {p.stage}
                      {p.totalRuns > 1 ? ` (${Math.max(1, p.run)}/${p.totalRuns})` : ""}
                    </span>
                    <span>{Math.round(frac * 100)}%</span>
                  </div>
                  <div className="progress">
                    <div style={{ width: `${frac * 100}%` }} />
                  </div>
                  <div className="progress-detail">
                    step {p.timestep.toLocaleString()} / {p.maxTimesteps.toLocaleString()}
                    {p.energyDb !== null ? ` · energy ${p.energyDb.toFixed(1)} dB (target ${p.endCriteriaDb})` : ""}
                    {p.speedMCs ? ` · ${p.speedMCs.toFixed(0)} MC/s` : ""}
                  </div>
                  <div className="port-row">
                    <button className="btn small" title="Stop time-stepping now and post-process what has been simulated" onClick={() => api.stopJob(job!.meta.id, "finish")}>
                      Finish now
                    </button>
                    <button className="btn small danger" onClick={() => api.stopJob(job!.meta.id, "kill")}>
                      Abort
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn primary run" disabled={!canRun} onClick={run}>
                  Run simulation
                  {built.stats && config.ports.filter((x) => x.excite).length > 1 ? ` (${config.ports.filter((x) => x.excite).length} runs)` : ""}
                </button>
              )}
            </div>
          </aside>
          <main className="main">
            <nav className="tabs">
              {(
                [
                  ["board", "Board & ports"],
                  ["mesh", "Mesh"],
                  ["results", "Results"],
                  ["log", "Solver log"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {label}
                  {id === "log" && running && <i className="status running" />}
                </button>
              ))}
              {job && (tab === "results" || tab === "log") && (
                <span className="tab-note">
                  <i className={`status ${job.meta.status}`} /> {job.meta.name} · {job.meta.status}
                </span>
              )}
            </nav>
            <div className="tab-body" hidden={tab !== "board"}>
              <PcbView model={doc.model} config={config} built={built} selection={selection} pickingSecondPad={pickingSecondPad} onPick={onPick} />
            </div>
            {tab === "mesh" && (
              <div className="tab-body">
                <MeshTab config={config} setConfig={setConfig} built={built} engineReady={!!engine && engine.mode !== "none"} />
              </div>
            )}
            {tab === "results" && (
              <div className="tab-body scroll">
                {job?.results ? (
                  <Results results={job.results} meta={job.meta} />
                ) : job?.meta.status === "failed" ? (
                  <div className="placeholder">
                    <div className="notice error">{job.meta.error ?? "The simulation failed."}</div>
                    <button className="btn" onClick={() => setTab("log")}>
                      Open solver log
                    </button>
                  </div>
                ) : (
                  <div className="placeholder">{running ? "Results appear here as soon as the first excitation run finishes." : "Run a simulation to see S-parameters, impedance and far-field results."}</div>
                )}
              </div>
            )}
            {tab === "log" && (
              <div className="tab-body">
                {job ? (
                  <pre className="log" ref={logRef}>
                    {job.log.join("\n")}
                  </pre>
                ) : (
                  <div className="placeholder">The openEMS console output appears here while a simulation runs.</div>
                )}
              </div>
            )}
          </main>
        </div>
      )}
      {dragOver && <div className="drop-overlay">Drop Circuit JSON to load it</div>}
    </div>
  )
}
