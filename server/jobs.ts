import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SimInput } from "../src/lib/types"
import type { AppConfig } from "./config"
import { type EngineInfo, type EngineManager, augmentedPath } from "./engine"

export type JobStatus = "running" | "done" | "failed" | "stopped" | "interrupted"

export interface JobMeta {
  id: string
  name: string
  circuitName: string
  createdAt: number
  finishedAt?: number
  status: JobStatus
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

interface LiveJob {
  meta: JobMeta
  log: string[]
  proc?: ReturnType<typeof spawn>
  containerName?: string
  currentRunDir?: string
  simStage?: string
  energyHistory: Array<{ ts: number; db: number }>
  excitationLength: number
  finishRequested: boolean
  killed: boolean
}

const MAX_LOG_LINES = 20000

export interface StartJobBody {
  name?: string
  circuitName?: string
  sim: SimInput
  config?: unknown
  circuitJson?: unknown
}

export const createJobs = (config: AppConfig, engines: EngineManager) => {
  const JOBS_DIR = join(config.dataDir, "jobs")
  mkdirSync(JOBS_DIR, { recursive: true })
  const live = new Map<string, LiveJob>()


  const jobDir = (id: string) => join(JOBS_DIR, id)
  const metaPath = (id: string) => join(jobDir(id), "meta.json")
  const saveMeta = (meta: JobMeta) => writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 1))
  const isSafeId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id)

  const readMeta = (id: string): JobMeta | null => {
    try {
      const meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as JobMeta
      if (meta.status === "running" && !live.has(id)) meta.status = "interrupted"
      return meta
    } catch {
      return null
    }
  }

  const listJobs = (): JobMeta[] => {
    const out: JobMeta[] = []
    for (const id of readdirSync(JOBS_DIR)) {
      const meta = live.get(id)?.meta ?? readMeta(id)
      if (meta) out.push(meta)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  const getJob = (id: string, since = 0) => {
    if (!isSafeId(id)) return null
    const lj = live.get(id)
    if (lj) return { meta: lj.meta, log: lj.log.slice(since), logLength: lj.log.length }
    const meta = readMeta(id)
    if (!meta) return null
    let log: string[] = []
    try {
      log = readFileSync(join(jobDir(id), "log.txt"), "utf8").split("\n")
      if (log[log.length - 1] === "") log.pop()
    } catch {}
    return { meta, log: log.slice(since), logLength: log.length }
  }

  const jobFile = (id: string, name: string): string | null => {
    if (!isSafeId(id) || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.includes("..")) return null
    const p = join(jobDir(id), name)
    return existsSync(p) ? p : null
  }

  const deleteJob = (id: string): boolean => {
    if (!isSafeId(id) || !existsSync(metaPath(id))) return false
    const lj = live.get(id)
    if (lj?.meta.status === "running") stopJob(id, "kill")
    live.delete(id)
    rmSync(jobDir(id), { recursive: true, force: true })
    return true
  }

  /**
   * "finish" asks openEMS to stop time-stepping gracefully (it polls for a file
   * called ABORT in the simulation directory) so results are still post-processed;
   * "kill" terminates the engine immediately.
   */
  const stopJob = (id: string, mode: "finish" | "kill"): boolean => {
    const lj = live.get(id)
    if (!lj || lj.meta.status !== "running") return false
    if (mode === "finish") {
      lj.finishRequested = true
      if (lj.currentRunDir) {
        try {
          writeFileSync(join(lj.currentRunDir, "ABORT"), "")
        } catch {}
      }
      pushLine(lj, ">>> Finish requested: stopping time-stepping and post-processing what has been simulated so far.")
      return true
    }
    lj.killed = true
    if (lj.containerName) spawn("docker", ["kill", lj.containerName], { stdio: "ignore", env: { ...process.env, PATH: augmentedPath() } }).on("error", () => {})
    lj.proc?.kill()
    return true
  }

  const pushLine = (lj: LiveJob, line: string) => {
    lj.log.push(line)
    if (lj.log.length > MAX_LOG_LINES) lj.log.splice(0, lj.log.length - MAX_LOG_LINES)
    try {
      appendFileSync(join(jobDir(lj.meta.id), "log.txt"), line + "\n")
    } catch {}
  }

  const PROGRESS_RE = /Timestep:\s*(\d+)\s*\|\|\s*Speed:\s*([\d.]+)\s*MC\/s.*Energy:\s*~?\S+\s*\(\s*-?\s*([\d.]+)dB\)/

  const handleLine = (lj: LiveJob, raw: string) => {
    const line = raw.replace(/\s+$/, "")
    if (!line) return
    const p = lj.meta.progress
    if (line.startsWith("@@EVENT ")) {
      try {
        const ev = JSON.parse(line.slice(8))
        switch (ev.event) {
          case "start":
            p.totalRuns = ev.excited.length
            p.cells = ev.cells
            pushLine(lj, `>>> openEMS ${ev.capabilities?.version ?? ""}: ${ev.mesh.join(" × ")} mesh lines, ${ev.cells.toLocaleString()} cells, ${ev.excited.length} excitation run(s)`)
            break
          case "run_start":
            p.run = ev.index + 1
            p.timestep = 0
            p.energyDb = null
            p.stage = lj.simStage = `Simulating — port ${ev.port} excited`
            lj.currentRunDir = join(jobDir(lj.meta.id), `run_port${ev.port}`)
            lj.energyHistory = []
            lj.finishRequested = false
            pushLine(lj, `>>> Run ${ev.index + 1}/${ev.total}: exciting port ${ev.port}`)
            break
          case "nf2ff_start":
            p.stage = "Computing far field"
            break
          case "fields_start":
            p.stage = "Saving fields"
            break
          case "run_done":
            lj.meta.resultsVersion++
            p.stage = "Post-processing"
            pushLine(lj, `>>> Run ${ev.index + 1}/${ev.total} finished in ${ev.seconds.toFixed(1)} s`)
            break
          case "warning":
            lj.meta.messages.push(ev.message)
            pushLine(lj, `>>> Warning: ${ev.message}`)
            break
          case "error":
            lj.meta.error = ev.message
            break
          case "done":
            p.stage = "Done"
            break
        }
      } catch {}
      saveMeta(lj.meta)
      return
    }
    pushLine(lj, line)
    if (/^Create FDTD operator/.test(line)) p.stage = "Building the openEMS mesh"
    else if (/^Running FDTD engine/.test(line) && lj.simStage) p.stage = lj.simStage
    const exc = /Excitation signal length is:\s*(\d+)\s*timesteps/.exec(line)
    if (exc) lj.excitationLength = Number(exc[1])
    const m = PROGRESS_RE.exec(line)
    if (m) {
      p.timestep = Number(m[1])
      p.speedMCs = Number(m[2])
      p.energyDb = -Number(m[3])
      // Energy that stops decaying is a static (DC) field or a lossless resonance: more
      // timesteps will not improve the port data, so stop this run and post-process.
      // Compare against the report at least two excitation lengths back.
      lj.energyHistory.push({ ts: p.timestep, db: p.energyDb })
      const window = 2 * Math.max(lj.excitationLength, 1000)
      const ref = [...lj.energyHistory].reverse().find((e) => e.ts <= p.timestep - window && e.ts > window)
      if (
        !lj.finishRequested &&
        ref &&
        p.energyDb < -15 &&
        p.energyDb > p.endCriteriaDb &&
        ref.db - p.energyDb < 0.25 &&
        lj.currentRunDir
      ) {
        lj.finishRequested = true
        try {
          writeFileSync(join(lj.currentRunDir, "ABORT"), "")
        } catch {}
        const msg = `Energy stopped decaying at ${p.energyDb.toFixed(1)} dB (residual static field, typical when the band starts near DC). The run was finished early; port data is converged.`
        if (!lj.meta.messages.includes(msg)) lj.meta.messages.push(msg)
        pushLine(lj, `>>> ${msg}`)
      }
    }
  }

  /** Feeds a child's output stream to handleLine, one line at a time. */
  const pump = (lj: LiveJob, stream: NodeJS.ReadableStream): Promise<void> =>
    new Promise((resolve) => {
      const decoder = new TextDecoder()
      let buf = ""
      stream.on("data", (chunk: Buffer) => {
        buf += decoder.decode(chunk, { stream: true })
        const parts = buf.split(/\r?\n|\r/)
        buf = parts.pop() ?? ""
        for (const part of parts) handleLine(lj, part)
      })
      const end = () => {
        if (buf) handleLine(lj, buf)
        buf = ""
        resolve()
      }
      stream.on("end", end)
      stream.on("error", end)
    })

  const startJob = (body: StartJobBody, engine: EngineInfo): JobMeta => {
    const sim = body.sim
    if (!sim || sim.version !== 1 || !sim.mesh || !Array.isArray(sim.ports)) throw new Error("Invalid simulation input")
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
    const dir = jobDir(id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "sim.json"), JSON.stringify(sim))
    if (body.config) writeFileSync(join(dir, "config.json"), JSON.stringify(body.config, null, 1))
    if (body.circuitJson) writeFileSync(join(dir, "circuit.json"), JSON.stringify(body.circuitJson))

    const cmd = engines.command(engine, dir, id)
    const meta: JobMeta = {
      id,
      name: body.name || body.circuitName || id,
      circuitName: body.circuitName ?? "",
      createdAt: Date.now(),
      status: "running",
      engine: engine.label,
      messages: [],
      progress: {
        run: 0,
        totalRuns: sim.ports.filter((p) => p.excite).length,
        timestep: 0,
        maxTimesteps: sim.max_timesteps,
        energyDb: null,
        endCriteriaDb: sim.end_criteria_db,
        speedMCs: null,
        cells: (sim.mesh.x.length - 1) * (sim.mesh.y.length - 1) * (sim.mesh.z.length - 1),
        stage: "Starting engine",
      },
      resultsVersion: 0,
    }
    const lj: LiveJob = { meta, log: [], containerName: cmd.containerName, energyHistory: [], excitationLength: 0, finishRequested: false, killed: false }
    live.set(id, lj)
    saveMeta(meta)
    pushLine(lj, `>>> ${cmd.argv.join(" ")}`)

    const proc = spawn(cmd.argv[0], cmd.argv.slice(1), { cwd: dir, env: cmd.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
    lj.proc = proc
    const exited = new Promise<number | null>((resolve) => {
      proc.on("error", (e) => {
        meta.error = `Could not start the engine: ${e.message}`
        resolve(-1)
      })
      proc.on("close", (code) => resolve(code))
    })
    Promise.all([pump(lj, proc.stdout!), pump(lj, proc.stderr!), exited]).then(([, , code]) => {
      meta.finishedAt = Date.now()
      if (lj.killed) meta.status = "stopped"
      else if (code === 0) meta.status = "done"
      else {
        meta.status = "failed"
        meta.error ??= `Engine exited with code ${code}. See the log for details.`
      }
      if (existsSync(join(dir, "results.json")) && meta.resultsVersion === 0) meta.resultsVersion = 1
      meta.progress.stage = meta.status === "done" ? "Done" : meta.status === "stopped" ? "Stopped" : "Failed"
      pushLine(lj, `>>> Job ${meta.status}${meta.error ? `: ${meta.error}` : ""}`)
      saveMeta(meta)
    })
    return meta
  }

  /** Terminates every running engine process (called when the desktop app quits). */
  const killAll = () => {
    for (const [id, lj] of live) if (lj.meta.status === "running") stopJob(id, "kill")
  }

  return { listJobs, getJob, jobFile, deleteJob, stopJob, startJob, killAll }
}

export type Jobs = ReturnType<typeof createJobs>
