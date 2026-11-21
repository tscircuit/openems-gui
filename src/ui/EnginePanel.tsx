import { useState } from "react"
import { type EngineCandidate, type EngineInfo, api } from "./api"

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`

export function EnginePanel({ engine, refresh, onClose }: { engine: EngineInfo; refresh: () => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const act = (fn: () => Promise<unknown>) => () => {
    setError(null)
    fn()
      .then(refresh)
      .catch((e) => setError(e?.message ?? String(e)))
  }
  const d = engine.download
  const downloading = d.state === "downloading" || d.state === "verifying" || d.state === "extracting"
  const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : null

  const actions = (c: EngineCandidate) => {
    if (c.kind === "managed") {
      if (downloading)
        return (
          <div className="progress-box">
            <div className="progress">
              <div style={{ width: `${d.state === "downloading" ? (pct ?? 5) : 100}%` }} />
            </div>
            <div className="progress-detail">
              {d.state === "downloading" ? `Downloading ${mb(d.received)}${d.total ? ` of ${mb(d.total)}` : ""}` : d.state === "verifying" ? "Verifying checksum…" : "Unpacking…"}
            </div>
          </div>
        )
      return (
        <div className="port-row">
          {d.supported && (
            <button className={`btn small${engine.mode === "none" ? " primary" : ""}`} onClick={act(api.downloadEngine)}>
              {c.available ? "Download again" : "Download openEMS"}
            </button>
          )}
          {c.available && (
            <button className="btn small danger" onClick={act(api.removeDownloadedEngine)}>
              Remove
            </button>
          )}
        </div>
      )
    }
    if (c.kind === "docker")
      return (
        <div className="port-row">
          <button className="btn small" disabled={!engine.docker.available || engine.docker.build.running} onClick={act(api.buildDockerEngine)}>
            {engine.docker.build.running ? "Building…" : c.available ? "Rebuild image" : "Build image (~5 min)"}
          </button>
        </div>
      )
    return null
  }

  return (
    <div className="engine-panel">
      <div className="engine-head">
        <div>
          <h2>openEMS engine</h2>
          <p className="hint">
            Simulations run in openEMS on this computer. The app can download a ready-to-run copy, use an openEMS you installed yourself, or run it in Docker.
            {engine.mode === "none" && " Nothing usable was found yet."}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn small" onClick={act(() => api.engine(true))}>
          Re-scan
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="engine-list">
        {engine.candidates.map((c) => {
          const active = engine.active?.kind === c.kind
          return (
            <div key={c.kind} className={`engine-card${active ? " active" : ""}`}>
              <div className="engine-card-title">
                <i className={`status ${c.available ? "done" : ""}`} />
                {c.label}
                <span className="tag">{active ? "in use" : c.available ? (c.version?.replace(/\.post.*|\+.*/, "") ?? "ready") : "not available"}</span>
              </div>
              <div className="engine-card-detail">{c.detail}</div>
              <div className="port-row">
                {actions(c)}
                {c.available && !active && (
                  <button className="btn small" onClick={act(() => api.preferEngine(c.kind))}>
                    Use this
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {engine.preferred !== "auto" && (
        <p className="hint">
          Preferring “{engine.candidates.find((c) => c.kind === engine.preferred)?.label ?? engine.preferred}”.{" "}
          <button className="link" onClick={act(() => api.preferEngine("auto"))}>
            Choose automatically
          </button>
        </p>
      )}
      {d.state === "error" && d.error && <div className="notice error">{d.error}</div>}
      {error && <div className="notice error">{error}</div>}
      {(engine.docker.build.running || engine.docker.build.log.length > 0) && <pre className="build-log">{engine.docker.build.log.slice(-14).join("\n")}</pre>}
      {engine.docker.build.error && <div className="notice error">{engine.docker.build.error}</div>}
    </div>
  )
}
