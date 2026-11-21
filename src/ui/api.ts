import type { SimInput, SimResults } from "../lib/types"

export interface JobMeta {
  id: string
  name: string
  circuitName: string
  createdAt: number
  finishedAt?: number
  status: "running" | "done" | "failed" | "stopped" | "interrupted"
  engine: string
  error?: string
  messages: string[]
  progress: {
    run: number
    totalRuns: number
    timestep: number
    maxTimesteps: number
    energyDb: number | null
    endCriteriaDb: number
    speedMCs: number | null
    cells: number
    stage: string
  }
  resultsVersion: number
}

export type EngineKind = "custom" | "bundled" | "managed" | "installed" | "docker"

export interface EngineCandidate {
  kind: EngineKind
  label: string
  detail: string
  available: boolean
  version?: string
  target: string
}

export interface EngineInfo {
  mode: EngineKind | "none"
  label: string
  active: EngineCandidate | null
  candidates: EngineCandidate[]
  preferred: EngineKind | "auto"
  platform: string
  download: { supported: boolean; url: string; state: "idle" | "downloading" | "verifying" | "extracting" | "error"; received: number; total: number; error: string | null }
  docker: { available: boolean; build: { running: boolean; log: string[]; error: string | null } }
}

const call = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as any).error ?? `${res.status} ${res.statusText}`)
  return data as T
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export const api = {
  engine: (refresh = false) => call<EngineInfo>(`/api/engine${refresh ? "?refresh" : ""}`),
  downloadEngine: () => call<{ ok: true }>("/api/engine/download", post({})),
  removeDownloadedEngine: () => call<{ ok: true }>("/api/engine/managed", { method: "DELETE" }),
  preferEngine: (kind: EngineKind | "auto") => call<EngineInfo>("/api/engine/prefer", post({ kind })),
  buildDockerEngine: () => call<{ ok: true }>("/api/engine/docker-build", post({})),
  examples: () => call<Array<{ id: string; title: string; description: string }>>("/api/examples"),
  example: (id: string) => call<unknown>(`/api/examples/${id}`),
  jobs: () => call<JobMeta[]>("/api/jobs"),
  job: (id: string, since: number) => call<{ meta: JobMeta; log: string[]; logLength: number }>(`/api/jobs/${id}?since=${since}`),
  startJob: (body: { name: string; circuitName: string; sim: SimInput; config: unknown; circuitJson: unknown }) => call<JobMeta>("/api/jobs", post(body)),
  stopJob: (id: string, mode: "finish" | "kill") => call<{ ok: true }>(`/api/jobs/${id}/stop`, post({ mode })),
  deleteJob: (id: string) => call<{ ok: true }>(`/api/jobs/${id}`, { method: "DELETE" }),
  results: (id: string) => call<SimResults>(`/api/jobs/${id}/files/results.json`),
  jobFile: <T,>(id: string, name: string) => call<T>(`/api/jobs/${id}/files/${name}`),
}
