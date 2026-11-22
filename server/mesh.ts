import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { MeshCheck, SimInput } from "../src/lib/types"
import type { AppConfig } from "./config"
import { type EngineInfo, type EngineManager, augmentedPath } from "./engine"

const MAX_LOG_LINES = 400

/**
 * The Mesh tab's "build in openEMS": runs the engine in setup-only mode (operator construction,
 * no time-stepping) on the current model and collects what openEMS reports about its grid, plus the
 * metal edges it placed on it. One build at a time; a new one replaces the previous.
 */
export const createMeshCheck = (config: AppConfig, engines: EngineManager) => {
  const dir = join(config.dataDir, "mesh-check")
  let state: MeshCheck = { status: "idle", key: "", log: [], stats: {} }
  let proc: ReturnType<typeof spawn> | null = null
  let containerName: string | undefined
  let generation = 0

  const stop = () => {
    generation++
    if (containerName) spawn("docker", ["kill", containerName], { stdio: "ignore", env: { ...process.env, PATH: augmentedPath() } }).on("error", () => {})
    proc?.kill()
    proc = null
    if (state.status === "running") state = { ...state, status: "idle" }
  }

  const handleLine = (st: MeshCheck, raw: string) => {
    const line = raw.replace(/\s+$/, "")
    if (!line) return
    if (line.startsWith("@@EVENT ")) {
      try {
        const ev = JSON.parse(line.slice(8))
        if (ev.event === "mesh_done") {
          st.seconds = ev.seconds
          st.pec = { points: ev.points, edges: ev.edges }
        } else if (ev.event === "error") st.error = ev.message
      } catch {}
      return
    }
    let m: RegExpExecArray | null
    if ((m = /Dimensions\s*:\s*(\d+)x(\d+)x(\d+)\s*=\s*(\d+)\s*Cells/.exec(line))) {
      st.stats.dims = [Number(m[1]), Number(m[2]), Number(m[3])]
      st.stats.cells = Number(m[4])
    } else if ((m = /Size of Operator\s*:\s*(\d+)\s*Byte/.exec(line))) st.stats.operatorBytes = Number(m[1])
    else if ((m = /Size of Field-Data\s*:\s*(\d+)\s*Byte/.exec(line))) st.stats.fieldBytes = Number(m[1])
    else if ((m = /Number of PEC edges\s*:\s*(\d+)/.exec(line))) st.stats.pecEdges = Number(m[1])
    else if ((m = /^Timestep \(s\)\s*:\s*([\d.eE+-]+)/.exec(line))) st.stats.timestepS = Number(m[1])
    else if ((m = /Nyquist criteria \(TS\)\s*:\s*(\d+)/.exec(line))) st.stats.nyquistTs = Number(m[1])
    else if ((m = /Excitation Length \(TS\)\s*:\s*(\d+)/.exec(line))) st.stats.excitationTs = Number(m[1])
    // openEMS repeats this once per overlapping pad; one line is enough
    if (line.startsWith("Warning: Unused primitive") && st.log.some((l) => l.startsWith("Warning: Unused primitive"))) return
    st.log.push(line)
    if (st.log.length > MAX_LOG_LINES) st.log.splice(0, st.log.length - MAX_LOG_LINES)
  }

  const start = (sim: SimInput, key: string, engine: EngineInfo): MeshCheck => {
    if (!sim || sim.version !== 1 || !sim.mesh || !Array.isArray(sim.polygons)) throw new Error("Invalid simulation input")
    stop()
    const gen = generation
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "sim.json"), JSON.stringify(sim))
    const cmd = engines.command(engine, dir, `mesh-${Date.now().toString(36)}`)
    containerName = cmd.containerName
    const st: MeshCheck = { status: "running", key, log: [`>>> ${[...cmd.argv, "--mesh"].join(" ")}`], stats: {} }
    state = st
    const started = Date.now()
    const child = spawn(cmd.argv[0], [...cmd.argv.slice(1), "--mesh"], { cwd: dir, env: cmd.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
    proc = child
    const pump = (stream: NodeJS.ReadableStream) => {
      const decoder = new TextDecoder()
      let buf = ""
      stream.on("data", (chunk: Buffer) => {
        buf += decoder.decode(chunk, { stream: true })
        const parts = buf.split(/\r?\n|\r/)
        buf = parts.pop() ?? ""
        for (const part of parts) handleLine(st, part)
      })
      stream.on("end", () => buf && handleLine(st, buf))
    }
    pump(child.stdout!)
    pump(child.stderr!)
    const finish = (code: number | null, message?: string) => {
      if (gen !== generation || st.status !== "running") return // replaced or stopped
      proc = null
      st.seconds ??= (Date.now() - started) / 1000
      if (code === 0 && !st.error) st.status = "done"
      else {
        st.status = "failed"
        st.error ??= message ?? `Engine exited with code ${code}. See the log.`
      }
    }
    child.on("error", (e) => finish(-1, `Could not start the engine: ${e.message}`))
    child.on("close", (code) => finish(code))
    return st
  }

  const get = (): MeshCheck => state
  const pecFile = (): string | null => {
    const p = join(dir, "pec.bin")
    return state.status === "done" && existsSync(p) ? p : null
  }

  return { start, stop, get, pecFile }
}

export type MeshChecker = ReturnType<typeof createMeshCheck>
