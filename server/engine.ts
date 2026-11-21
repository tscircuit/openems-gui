/**
 * Finds, downloads and launches the openEMS engine.
 *
 * An "engine" is a Python interpreter that can `import openEMS, CSXCAD`, or a
 * Docker image that contains one. Candidates, in the order "auto" tries them:
 *
 *   custom     $OPENEMS_PYTHON
 *   bundled    <resources>/openems-engine   shipped inside the desktop app
 *   managed    <data>/openems-engine        downloaded by the app (prebuilt bundle)
 *   installed  an openEMS the user installed themselves (python3 on PATH, ~/opt/openEMS/venv, …)
 *   docker     the openems-gui-engine image, built from engine/Dockerfile
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { ENGINE_RELEASE_TAG, ENGINE_REPO, engineAssetName } from "./engine-release"
import type { AppConfig } from "./config"

export type EngineKind = "custom" | "bundled" | "managed" | "installed" | "docker"

export interface EngineCandidate {
  kind: EngineKind
  label: string
  detail: string
  available: boolean
  version?: string
  /** python executable, or docker image tag */
  target: string
}

export interface EngineInfo {
  mode: EngineKind | "none"
  label: string
  active: EngineCandidate | null
  candidates: EngineCandidate[]
  preferred: EngineKind | "auto"
  platform: string
  download: {
    supported: boolean
    url: string
    state: "idle" | "downloading" | "verifying" | "extracting" | "error"
    received: number
    total: number
    error: string | null
  }
  docker: { available: boolean; build: { running: boolean; log: string[]; error: string | null } }
}

export const DOCKER_IMAGE = "openems-gui-engine:source"
const KIND_ORDER: EngineKind[] = ["custom", "bundled", "managed", "installed", "docker"]

const PROBE = "import openEMS, CSXCAD; print('OPENEMS_OK', getattr(openEMS, '__version__', 'unknown'))"

/** GUI apps on macOS / Linux start with a minimal PATH; add the usual places tools live. */
export const augmentedPath = (): string => {
  const extra = process.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), ".pyenv/shims"), "/opt/local/bin"]
  const parts = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const p of extra) if (!parts.includes(p)) parts.push(p)
  return parts.join(delimiter)
}

const run = (argv: string[], timeoutMs = 15000): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    let out = ""
    let done = false
    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { env: { ...process.env, PATH: augmentedPath() }, stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      return resolve({ code: -1, out: "" })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(-2)
    }, timeoutMs)
    child.stdout?.on("data", (d) => (out += d))
    child.stderr?.on("data", (d) => (out += d))
    child.on("error", () => finish(-1))
    child.on("close", (code) => finish(code ?? -1))
  })

export const enginePython = (root: string) => (process.platform === "win32" ? join(root, "python.exe") : join(root, "bin", "python3"))

export const currentPlatform = () => `${process.platform}-${process.arch}`

export const createEngineManager = (config: AppConfig) => {
  const managedDir = join(config.dataDir, "openems-engine")
  const bundledDir = config.resourcesDir ? join(config.resourcesDir, "openems-engine") : null
  const settingsPath = join(config.dataDir, "settings.json")
  const asset = engineAssetName(currentPlatform())
  const downloadUrl = process.env.OPENEMS_ENGINE_URL ?? (asset ? `https://github.com/${ENGINE_REPO}/releases/download/${ENGINE_RELEASE_TAG}/${asset}` : "")

  const download: EngineInfo["download"] = { supported: !!downloadUrl, url: downloadUrl, state: "idle", received: 0, total: 0, error: null }
  const dockerBuild: EngineInfo["docker"]["build"] = { running: false, log: [], error: null }
  let cache: { at: number; info: EngineInfo } | null = null
  const probeCache = new Map<string, { at: number; version: string | null }>()

  const readSettings = (): { preferredEngine?: EngineKind | "auto" } => {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf8"))
    } catch {
      return {}
    }
  }

  const probePython = async (python: string, force: boolean): Promise<string | null> => {
    const hit = probeCache.get(python)
    if (!force && hit && Date.now() - hit.at < 60000) return hit.version
    const r = await run([python, "-c", PROBE], 30000)
    const m = /OPENEMS_OK (\S+)/.exec(r.out)
    const version = r.code === 0 && m ? m[1] : null
    probeCache.set(python, { at: Date.now(), version })
    return version
  }

  const detect = async (force = false): Promise<EngineInfo> => {
    if (!force && cache && Date.now() - cache.at < 4000) return cache.info
    const candidates: EngineCandidate[] = []

    if (process.env.OPENEMS_PYTHON) {
      const v = await probePython(process.env.OPENEMS_PYTHON, force)
      candidates.push({ kind: "custom", label: "Custom Python", detail: `$OPENEMS_PYTHON = ${process.env.OPENEMS_PYTHON}`, available: !!v, version: v ?? undefined, target: process.env.OPENEMS_PYTHON })
    }
    if (bundledDir && existsSync(enginePython(bundledDir))) {
      const v = await probePython(enginePython(bundledDir), force)
      candidates.push({ kind: "bundled", label: "Bundled openEMS", detail: "Shipped inside this app", available: !!v, version: v ?? undefined, target: enginePython(bundledDir) })
    }
    {
      const py = enginePython(managedDir)
      const present = existsSync(py)
      const v = present ? await probePython(py, force) : null
      candidates.push({
        kind: "managed",
        label: "Downloaded openEMS",
        detail: present ? managedDir : download.supported ? "Prebuilt openEMS for this computer — not downloaded yet" : `No prebuilt openEMS for ${currentPlatform()}`,
        available: !!v,
        version: v ?? undefined,
        target: py,
      })
    }
    {
      const guesses = ["python3", "python", join(homedir(), "opt/openEMS/venv/bin/python3"), "/opt/openEMS/venv/bin/python3", "/usr/local/opt/openEMS/venv/bin/python3"]
      let found: { py: string; v: string } | null = null
      for (const py of guesses) {
        if (py.includes("/") && !existsSync(py)) continue
        const v = await probePython(py, force)
        if (v) {
          found = { py, v }
          break
        }
      }
      candidates.push({
        kind: "installed",
        label: "Installed openEMS",
        detail: found ? `Found via ${found.py}` : "No openEMS Python module found on this computer",
        available: !!found,
        version: found?.v,
        target: found?.py ?? "",
      })
    }
    const dockerVersion = await run(["docker", "version", "--format", "{{.Server.Version}}"], 8000)
    const dockerAvailable = dockerVersion.code === 0
    let imageReady = false
    if (dockerAvailable) imageReady = (await run(["docker", "image", "inspect", DOCKER_IMAGE, "--format", "ok"], 8000)).code === 0
    candidates.push({
      kind: "docker",
      label: "Docker",
      detail: !dockerAvailable ? "Docker is not running" : imageReady ? `Image ${DOCKER_IMAGE}` : `Image ${DOCKER_IMAGE} not built yet`,
      available: imageReady,
      target: DOCKER_IMAGE,
    })

    const preferred = readSettings().preferredEngine ?? "auto"
    const usable = candidates.filter((c) => c.available).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    const forced = process.env.OPENEMS_ENGINE as EngineKind | undefined
    const active = usable.find((c) => c.kind === forced) ?? usable.find((c) => c.kind === preferred) ?? usable[0] ?? null
    const info: EngineInfo = {
      mode: active?.kind ?? "none",
      label: active ? `${active.label}${active.version ? ` ${active.version.replace(/\.post.*|\+.*/, "")}` : ""}` : "No openEMS engine",
      active,
      candidates,
      preferred,
      platform: currentPlatform(),
      download,
      docker: { available: dockerAvailable, build: dockerBuild },
    }
    cache = { at: Date.now(), info }
    return info
  }

  const setPreferred = (kind: EngineKind | "auto") => {
    mkdirSync(config.dataDir, { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ ...readSettings(), preferredEngine: kind }, null, 1))
    cache = null
  }

  const sha256 = (file: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const h = createHash("sha256")
      createReadStream(file)
        .on("data", (d) => h.update(d))
        .on("end", () => resolve(h.digest("hex")))
        .on("error", reject)
    })

  /** Downloads and unpacks the prebuilt engine for this platform into the data directory. */
  const startDownload = (): boolean => {
    if (!download.supported || ["downloading", "verifying", "extracting"].includes(download.state)) return false
    download.state = "downloading"
    download.received = 0
    download.total = 0
    download.error = null
    const tmpDir = join(config.dataDir, "downloads")
    const archive = join(tmpDir, "openems-engine.tar.gz")
    const staging = join(config.dataDir, "openems-engine.staging")
    ;(async () => {
      mkdirSync(tmpDir, { recursive: true })
      if (downloadUrl.startsWith("file://") || downloadUrl.startsWith("/")) {
        // local bundle (development / offline install)
        const src = downloadUrl.replace(/^file:\/\//, "")
        await new Promise<void>((resolve, reject) => {
          createReadStream(src)
            .on("data", (d) => (download.received += d.length))
            .on("error", reject)
            .pipe(createWriteStream(archive))
            .on("finish", () => resolve())
            .on("error", reject)
        })
        download.total = download.received
      } else {
        const res = await fetch(downloadUrl, { redirect: "follow" })
        if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText} (${downloadUrl})`)
        download.total = Number(res.headers.get("content-length") ?? 0)
        const out = createWriteStream(archive)
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          download.received += value.length
          if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()))
        }
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
      }

      download.state = "verifying"
      let expected: string | null = null
      try {
        if (downloadUrl.startsWith("http")) {
          const r = await fetch(`${downloadUrl}.sha256`, { redirect: "follow" })
          if (r.ok) expected = (await r.text()).trim().split(/\s+/)[0]
        } else if (existsSync(`${downloadUrl.replace(/^file:\/\//, "")}.sha256`)) {
          expected = readFileSync(`${downloadUrl.replace(/^file:\/\//, "")}.sha256`, "utf8").trim().split(/\s+/)[0]
        }
      } catch {}
      if (expected) {
        const actual = await sha256(archive)
        if (actual !== expected) throw new Error("Downloaded engine failed its checksum; please try again.")
      }

      download.state = "extracting"
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      const tar = await run(["tar", "-xzf", archive, "-C", staging], 10 * 60000)
      if (tar.code !== 0) throw new Error(`Could not unpack the engine: ${tar.out.slice(-300)}`)
      if (!existsSync(enginePython(join(staging, "openems-engine")))) throw new Error("The downloaded archive does not contain an openEMS engine.")
      rmSync(managedDir, { recursive: true, force: true })
      renameSync(join(staging, "openems-engine"), managedDir)
      rmSync(staging, { recursive: true, force: true })
      rmSync(archive, { force: true })
      probeCache.clear()
      cache = null
      const v = await probePython(enginePython(managedDir), true)
      if (!v) throw new Error("The downloaded engine does not start on this computer.")
      download.state = "idle"
    })().catch((e: any) => {
      download.state = "error"
      download.error = e?.message ?? String(e)
      rmSync(staging, { recursive: true, force: true })
    })
    return true
  }

  const removeManaged = () => {
    rmSync(managedDir, { recursive: true, force: true })
    probeCache.clear()
    cache = null
  }

  const startDockerBuild = (): boolean => {
    if (dockerBuild.running) return false
    dockerBuild.running = true
    dockerBuild.log = []
    dockerBuild.error = null
    const child = spawn("docker", ["build", "--progress=plain", "-t", DOCKER_IMAGE, "-f", join(config.engineDir, "Dockerfile"), config.engineDir], {
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const onData = (d: Buffer) => {
      dockerBuild.log.push(...d.toString().split(/\r?\n/).filter(Boolean))
      if (dockerBuild.log.length > 400) dockerBuild.log.splice(0, dockerBuild.log.length - 400)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("error", (e) => {
      dockerBuild.running = false
      dockerBuild.error = e.message
    })
    child.on("close", (code) => {
      dockerBuild.running = false
      if (code !== 0) dockerBuild.error = `docker build exited with code ${code}`
      cache = null
    })
    return true
  }

  /** argv + env that runs engine/run_sim.py on a job directory with the active engine. */
  const command = (engine: EngineInfo, jobDir: string, jobId: string): { argv: string[]; env: Record<string, string | undefined>; containerName?: string } => {
    const active = engine.active
    if (!active) throw new Error("No openEMS engine available. Open the engine panel to download or select one.")
    const env = { ...process.env, PATH: augmentedPath(), PYTHONUNBUFFERED: "1" }
    if (active.kind === "docker") {
      const containerName = `openems-gui-${jobId}`
      return {
        containerName,
        env,
        argv: ["docker", "run", "--rm", "--name", containerName, "-v", `${jobDir}:/job`, "-v", `${config.engineDir}:/engine:ro`, active.target, "python3", "/engine/run_sim.py", "/job"],
      }
    }
    const isolated = active.kind === "bundled" || active.kind === "managed"
    return { argv: [active.target, join(config.engineDir, "run_sim.py"), jobDir], env: isolated ? { ...env, PYTHONNOUSERSITE: "1", PYTHONPATH: undefined, PYTHONHOME: undefined } : env }
  }

  return { detect, setPreferred, startDownload, removeManaged, startDockerBuild, command, managedDir }
}

export type EngineManager = ReturnType<typeof createEngineManager>
