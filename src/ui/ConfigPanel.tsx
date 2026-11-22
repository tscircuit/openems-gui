import { useEffect, useState } from "react"
import { SUBSTRATE_PRESETS, defaultFields } from "../lib/build-sim"
import type { BuildResult, Pad, PcbModel, PortDef, SimConfig } from "../lib/types"
import type { Selection } from "./PcbView"

export function Num({
  label,
  value,
  onChange,
  unit,
  step,
  min,
  title,
  placeholder,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  unit?: string
  step?: number
  min?: number
  title?: string
  placeholder?: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    if (Number.parseFloat(text) !== value) setText(Number.isFinite(value) ? String(value) : "")
  }, [value])
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <div className="input-wrap">
        <input
          type="number"
          value={text}
          step={step ?? "any"}
          min={min}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            const v = Number.parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit && <em>{unit}</em>}
      </div>
    </label>
  )
}

function Section({ title, children, defaultOpen = true, badge }: { title: string; children: React.ReactNode; defaultOpen?: boolean; badge?: string }) {
  return (
    <details className="section" open={defaultOpen}>
      <summary>
        {title}
        {badge && <span className="badge">{badge}</span>}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  )
}

interface Props {
  model: PcbModel
  config: SimConfig
  setConfig: (c: SimConfig) => void
  built: BuildResult
  selection: Selection | null
  pickingSecondPad: boolean
  setPickingSecondPad: (v: boolean) => void
  openMesh: () => void
}

let portSeq = 0
const newId = () => `port-${Date.now().toString(36)}-${portSeq++}`

export function ConfigPanel({ model, config, setConfig, built, selection, pickingSecondPad, setPickingSecondPad, openMesh }: Props) {
  const set = (patch: Partial<SimConfig>) => setConfig({ ...config, ...patch })
  const fields = config.fields ?? defaultFields(config.thickness)
  const setFields = (patch: Partial<SimConfig["fields"]>) => set({ fields: { ...fields, ...patch } })
  const [freqText, setFreqText] = useState(fields.freqsGHz.join(", "))
  useEffect(() => {
    const parsed = freqText.split(/[\s,;]+/).map(Number).filter((v) => Number.isFinite(v) && v > 0)
    if (parsed.join(",") !== fields.freqsGHz.join(",")) setFreqText(fields.freqsGHz.join(", "))
  }, [fields.freqsGHz.join(",")])
  const padById = new Map(model.pads.map((p) => [p.id, p]))
  const selPad: Pad | null = selection?.kind === "pad" ? (padById.get(selection.padId) ?? null) : null
  const otherLayers = (l: string) => model.layers.filter((x) => x !== l)
  const [refLayer, setRefLayer] = useState<string>("bottom")

  const selLayer = selPad ? selPad.layers[0] : selection?.kind === "point" ? selection.layer : null
  const refChoices = selLayer ? otherLayers(selLayer) : []
  const ref = refChoices.includes(refLayer) ? refLayer : (refChoices[refChoices.length - 1] ?? "")

  const addVertical = () => {
    if (!selection || !selLayer || !ref) return
    const n = config.ports.length + 1
    const base = { id: newId(), kind: "vertical" as const, layer: selLayer, refLayer: ref, impedance: 50, excite: config.ports.length === 0 || config.ports.every((p) => p.excite) }
    const port: PortDef = selPad
      ? { ...base, name: `P${n} (${selPad.label})`, x: selPad.x, y: selPad.y, padId: selPad.id }
      : { ...base, name: `P${n}`, x: (selection as any).x, y: (selection as any).y }
    set({ ports: [...config.ports, port] })
  }

  const updatePort = (id: string, patch: Partial<PortDef>) => set({ ports: config.ports.map((p) => (p.id === id ? ({ ...p, ...patch } as PortDef) : p)) })
  const passives = model.components.filter((c) => c.passive)
  const preset = Object.entries(SUBSTRATE_PRESETS).find(([, p]) => p.epsR === config.epsR && p.tanD === config.tanD)?.[0] ?? "custom"
  const s = built.stats
  const memMb = s ? (s.cells * 60) / 1e6 : 0

  return (
    <div className="config">
      <Section title="Ports" badge={String(config.ports.length)}>
        {config.ports.length === 0 && <p className="hint">Click a pad (or any copper) on the board to place a port.</p>}
        {config.ports.map((p, i) => {
          const g = built.ports.find((x) => x.number === i + 1)
          const a = p.kind === "lateral" ? padById.get(p.padA) : null
          const b = p.kind === "lateral" ? padById.get(p.padB) : null
          return (
            <div className="port-card" key={p.id}>
              <div className="port-row">
                <span className={`port-num${p.excite ? " excited" : ""}`}>{i + 1}</span>
                <input className="port-name" value={p.name} onChange={(e) => updatePort(p.id, { name: e.target.value })} aria-label="Port name" />
                <button className="icon-btn" title="Remove port" onClick={() => set({ ports: config.ports.filter((x) => x.id !== p.id) })}>
                  ×
                </button>
              </div>
              <div className="port-desc">
                {p.kind === "vertical" ? (
                  <>
                    {p.layer} → {p.refLayer} at ({p.x.toFixed(2)}, {p.y.toFixed(2)}) mm
                  </>
                ) : (
                  <>
                    between {a?.label ?? "?"} and {b?.label ?? "?"}
                    {g ? ` (${g.direction}-directed)` : ""}
                  </>
                )}
              </div>
              <div className="grid3">
                <Num label="Z₀" unit="Ω" value={p.impedance} min={0} onChange={(v) => updatePort(p.id, { impedance: v })} />
                {p.kind === "vertical" ? (
                  <>
                    <Num label="x" unit="mm" value={p.x} onChange={(v) => updatePort(p.id, { x: v, padId: undefined })} />
                    <Num label="y" unit="mm" value={p.y} onChange={(v) => updatePort(p.id, { y: v, padId: undefined })} />
                  </>
                ) : (
                  <span />
                )}
              </div>
              <div className="port-row">
                <label className="check" title="Excited ports each get their own FDTD run and produce a column of the S-matrix">
                  <input type="checkbox" checked={p.excite} onChange={(e) => updatePort(p.id, { excite: e.target.checked })} />
                  Excite
                </label>
                {p.kind === "vertical" && (
                  <label className="inline-select">
                    reference
                    <select value={p.refLayer} onChange={(e) => updatePort(p.id, { refLayer: e.target.value })}>
                      {otherLayers(p.layer).map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
          )
        })}
        {selection && selLayer && (
          <div className="selection-card">
            <div className="selection-title">
              {selPad ? (
                <>
                  <b>{selPad.label}</b>
                  {selPad.net ? ` · net ${selPad.net}` : ""} · {selLayer}
                </>
              ) : (
                <>
                  Copper on <b>{selLayer}</b> at ({(selection as any).x}, {(selection as any).y})
                </>
              )}
            </div>
            <div className="port-row">
              <button className="btn small primary" onClick={addVertical} disabled={!ref}>
                Add port to plane
              </button>
              <select value={ref} onChange={(e) => setRefLayer(e.target.value)} aria-label="Reference layer">
                {refChoices.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </div>
            {selPad && (
              <button className={`btn small${pickingSecondPad ? " active" : ""}`} onClick={() => setPickingSecondPad(!pickingSecondPad)}>
                {pickingSecondPad ? "Cancel — click a second pad…" : "Add port between this pad and another…"}
              </button>
            )}
          </div>
        )}
      </Section>

      <Section title="Frequency">
        <div className="grid2">
          <Num label="Start" unit="GHz" value={config.fStartGHz} min={0} onChange={(v) => set({ fStartGHz: v })} />
          <Num label="Stop" unit="GHz" value={config.fStopGHz} min={0} onChange={(v) => set({ fStopGHz: v })} />
          <Num label="Points" value={config.freqPoints} min={2} step={1} onChange={(v) => set({ freqPoints: v })} />
        </div>
        <p className="hint">Gaussian pulse centred at {((config.fStartGHz + config.fStopGHz) / 2).toFixed(2)} GHz. Bands that start near DC take longer to settle.</p>
      </Section>

      <Section title="Substrate & copper">
        <label className="field">
          <span>Material</span>
          <select
            value={preset}
            onChange={(e) => {
              const p = SUBSTRATE_PRESETS[e.target.value]
              if (p) set({ epsR: p.epsR, tanD: p.tanD })
            }}
          >
            {Object.entries(SUBSTRATE_PRESETS).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
              </option>
            ))}
            {preset === "custom" && <option value="custom">Custom</option>}
          </select>
        </label>
        <div className="grid3">
          <Num label="εr" value={config.epsR} min={1} onChange={(v) => set({ epsR: v })} />
          <Num label="tan δ" value={config.tanD} min={0} onChange={(v) => set({ tanD: v })} />
          <Num label="Thickness" unit="mm" value={config.thickness} min={0} onChange={(v) => set({ thickness: v })} />
        </div>
        <label className="field">
          <span>Copper model</span>
          <select value={config.copperModel} onChange={(e) => set({ copperModel: e.target.value as SimConfig["copperModel"] })}>
            <option value="pec">Perfect conductor (fast)</option>
            <option value="sheet">Lossy conducting sheet</option>
          </select>
        </label>
        {config.copperModel === "sheet" && (
          <div className="grid2">
            <Num label="Thickness" unit="µm" value={config.copperThicknessUm} min={0} onChange={(v) => set({ copperThicknessUm: v })} />
            <Num label="Conductivity" unit="S/m" value={config.copperConductivity} min={0} onChange={(v) => set({ copperConductivity: v })} />
          </div>
        )}
        <label className="field" title="Adds an ideal solid copper plane covering the whole simulated board area on this layer">
          <span>Add solid ground plane</span>
          <select value={config.groundPlaneLayer ?? ""} onChange={(e) => set({ groundPlaneLayer: e.target.value || null })}>
            <option value="">None (use copper from the file)</option>
            {model.layers.map((l) => (
              <option key={l} value={l}>
                on {l}
              </option>
            ))}
          </select>
        </label>
        {passives.length > 0 && (
          <>
            <label className="check">
              <input type="checkbox" checked={config.modelPassives} onChange={(e) => set({ modelPassives: e.target.checked })} />
              Model R / L / C parts as lumped elements
            </label>
            <div className="passives">
              {passives.map((c) => (
                <span key={c.id} className={`chip${built.lumped.some((l) => l.name === c.name) ? " on" : ""}`}>
                  {c.name} {c.passive!.display}
                </span>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title="Mesh" badge={s ? `${(s.cells / 1e6).toFixed(s.cells < 1e5 ? 3 : 2)} M cells` : undefined}>
        {s && (
          <p className="hint" style={{ marginTop: 0 }}>
            {s.nx} × {s.ny} × {s.nz} lines · smallest cell {s.minCell.toFixed(3)} mm · ≈ {memMb < 1000 ? `${memMb.toFixed(0)} MB` : `${(memMb / 1000).toFixed(1)} GB`} RAM
          </p>
        )}
        <button className="btn small" onClick={openMesh}>
          Mesh settings, boundaries and 3D preview →
        </button>
      </Section>

      <Section title="Solver" defaultOpen={false}>
        <div className="grid2">
          <Num label="End criterion" unit="dB" value={config.endCriteriaDb} title="Stop when field energy has decayed this far below its peak" onChange={(v) => set({ endCriteriaDb: -Math.abs(v) })} />
          <Num label="Max timesteps" value={config.maxTimesteps} min={100} step={1000} onChange={(v) => set({ maxTimesteps: v })} />
          <Num label="Threads" value={config.threads} min={0} step={1} title="0 = let openEMS decide" onChange={(v) => set({ threads: Math.max(0, Math.round(v)) })} />
        </div>
      </Section>

      <Section title="Fields & far field" defaultOpen={false} badge={[fields.frequency || fields.time ? "fields" : "", config.nf2ff.enabled ? "far field" : ""].filter(Boolean).join(" + ") || undefined}>
        <label className="check" title="E and H in a box around the board, as 3D slices under Results → 3D fields">
          <input type="checkbox" checked={fields.frequency} onChange={(e) => setFields({ frequency: e.target.checked })} />
          Record fields at set frequencies
        </label>
        {fields.frequency && (
          <label className="field">
            <span>Frequencies, GHz (up to 3, empty = band centre)</span>
            <input
              type="text"
              value={freqText}
              placeholder={((config.fStartGHz + config.fStopGHz) / 2).toFixed(2)}
              onChange={(e) => {
                setFreqText(e.target.value)
                setFields({ freqsGHz: e.target.value.split(/[\s,;]+/).map(Number).filter((v) => Number.isFinite(v) && v > 0).slice(0, 3) })
              }}
            />
          </label>
        )}
        <label className="check" title="A movie of the excitation pulse travelling through the board, on a plane inside the substrate">
          <input type="checkbox" checked={fields.time} onChange={(e) => setFields({ time: e.target.checked })} />
          Record the E field over time (pulse animation)
        </label>
        {(fields.frequency || fields.time) && (
          <>
            {fields.frequency && <Num label="Recorded height above and below the board" unit="mm" value={fields.height} min={0} onChange={(v) => setFields({ height: v })} />}
            <p className="hint">
              {fields.frequency && s ? `${s.dumpPoints.volume.toLocaleString()} points per frequency. ` : ""}
              {fields.time && s ? `${s.dumpPoints.plane.toLocaleString()} points per movie frame; up to ${s.movieTempBytes >= 1e9 ? `${(s.movieTempBytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(s.movieTempBytes / 1e6))} MB`} of temporary data if the run uses every timestep. ` : ""}
              Recording slows the solver slightly.
            </p>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={config.nf2ff.enabled} onChange={(e) => set({ nf2ff: { ...config.nf2ff, enabled: e.target.checked } })} />
          Compute far field (antenna pattern)
        </label>
        {config.nf2ff.enabled && (
          <Num
            label="Far-field frequency (0 = at best match)"
            unit="GHz"
            value={config.nf2ff.freqGHz}
            min={0}
            onChange={(v) => set({ nf2ff: { ...config.nf2ff, freqGHz: v } })}
          />
        )}
      </Section>

      <Section title="Region" defaultOpen={false} badge={config.region ? "cropped" : "whole board"}>
        <label className="check">
          <input
            type="checkbox"
            checked={!!config.region}
            onChange={(e) => set({ region: e.target.checked ? { minX: model.board.minX, minY: model.board.minY, maxX: model.board.maxX, maxY: model.board.maxY } : null })}
          />
          Simulate only part of the board
        </label>
        {config.region && (
          <div className="grid2">
            <Num label="x min" unit="mm" value={config.region.minX} onChange={(v) => set({ region: { ...config.region!, minX: v } })} />
            <Num label="x max" unit="mm" value={config.region.maxX} onChange={(v) => set({ region: { ...config.region!, maxX: v } })} />
            <Num label="y min" unit="mm" value={config.region.minY} onChange={(v) => set({ region: { ...config.region!, minY: v } })} />
            <Num label="y max" unit="mm" value={config.region.maxY} onChange={(v) => set({ region: { ...config.region!, maxY: v } })} />
          </div>
        )}
        <p className="hint">Copper is clipped at the region edge. Use this to isolate one RF section of a large board.</p>
      </Section>
    </div>
  )
}

export const addLateralPort = (config: SimConfig, a: Pad, b: Pad): SimConfig => {
  const n = config.ports.length + 1
  return {
    ...config,
    ports: [
      ...config.ports,
      { id: newId(), kind: "lateral", name: `P${n} (${a.label} ↔ ${b.label})`, padA: a.id, padB: b.id, impedance: 50, excite: config.ports.length === 0 || config.ports.every((p) => p.excite) },
    ],
  }
}
