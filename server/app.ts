/**
 * The HTTP API, written against the fetch Request/Response types so the same
 * code runs under Bun (development), plain Node, and Electron's main process.
 */
import { createReadStream, existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, sep } from "node:path"
import { Readable } from "node:stream"
import { EXAMPLES } from "../src/lib/examples"
import type { AppConfig } from "./config"
import { type EngineKind, createEngineManager } from "./engine"
import type { SimInput } from "../src/lib/types"
import { createJobs } from "./jobs"
import { createMeshCheck } from "./mesh"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
const err = (message: string, status = 400) => json({ error: message }, status)

const fileResponse = (path: string, headers: Record<string, string> = {}) => {
  const size = statSync(path).size
  return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
    headers: { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "content-length": String(size), ...headers },
  })
}

export const createApp = (config: AppConfig) => {
  const engines = createEngineManager(config)
  const jobs = createJobs(config, engines)
  const mesh = createMeshCheck(config, engines)

  const api = async (req: Request, path: string, url: URL): Promise<Response> => {
    const method = req.method.toUpperCase()
    const body = async <T,>() => (await req.json().catch(() => ({}))) as T
    let m: RegExpExecArray | null

    if (path === "/api/engine" && method === "GET") return json(await engines.detect(url.searchParams.has("refresh")))
    if (path === "/api/engine/download" && method === "POST") {
      const info = await engines.detect()
      if (!info.download.supported) return err(`There is no prebuilt openEMS for ${info.platform}. Install openEMS yourself or use Docker.`, 409)
      return engines.startDownload() ? json({ ok: true }) : err("A download is already running.", 409)
    }
    if (path === "/api/engine/managed" && method === "DELETE") {
      engines.removeManaged()
      return json({ ok: true })
    }
    if (path === "/api/engine/prefer" && method === "POST") {
      const { kind } = await body<{ kind?: EngineKind | "auto" }>()
      if (!kind || !["auto", "custom", "bundled", "managed", "installed", "docker"].includes(kind)) return err("Unknown engine kind")
      engines.setPreferred(kind)
      return json(await engines.detect(true))
    }
    if (path === "/api/engine/docker-build" && method === "POST") {
      const info = await engines.detect(true)
      if (!info.docker.available) return err("Docker is not running. Start Docker Desktop and try again.", 409)
      return engines.startDockerBuild() ? json({ ok: true }) : err("An image build is already running.", 409)
    }

    if (path === "/api/examples" && method === "GET") return json(EXAMPLES.map((e) => ({ id: e.id, title: e.title, description: e.description })))
    if ((m = /^\/api\/examples\/([\w-]+)$/.exec(path)) && method === "GET") {
      const ex = EXAMPLES.find((e) => e.id === m![1])
      if (!ex) return err("Unknown example", 404)
      return new Response(await readFile(join(config.examplesDir, ex.file)), { headers: { "content-type": "application/json" } })
    }

    if (path === "/api/mesh" && method === "GET") return json(mesh.get())
    if (path === "/api/mesh" && method === "POST") {
      try {
        const engine = await engines.detect()
        if (!engine.active) return err("No openEMS engine available. Open the engine panel to download or select one.", 409)
        const { sim, key } = await body<{ sim: SimInput; key?: string }>()
        return json(mesh.start(sim, String(key ?? ""), engine))
      } catch (e: any) {
        return err(e?.message ?? String(e))
      }
    }
    if (path === "/api/mesh" && method === "DELETE") {
      mesh.stop()
      return json(mesh.get())
    }
    if (path === "/api/mesh/pec" && method === "GET") {
      const p = mesh.pecFile()
      return p ? fileResponse(p, { "cache-control": "no-store" }) : err("No mesh has been built", 404)
    }

    if (path === "/api/jobs" && method === "GET") return json(jobs.listJobs())
    if (path === "/api/jobs" && method === "POST") {
      try {
        const engine = await engines.detect()
        if (!engine.active) return err("No openEMS engine available. Open the engine panel to download or select one.", 409)
        return json(jobs.startJob(await req.json(), engine))
      } catch (e: any) {
        return err(e?.message ?? String(e))
      }
    }
    if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(path))) {
      if (method === "GET") {
        const job = jobs.getJob(m[1], Number(url.searchParams.get("since") ?? 0) || 0)
        return job ? json(job) : err("Job not found", 404)
      }
      if (method === "DELETE") return jobs.deleteJob(m[1]) ? json({ ok: true }) : err("Job not found", 404)
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/stop$/.exec(path)) && method === "POST") {
      const { mode } = await body<{ mode?: "finish" | "kill" }>()
      return jobs.stopJob(m[1], mode === "finish" ? "finish" : "kill") ? json({ ok: true }) : err("Job is not running", 409)
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/files\/([\w.-]+)$/.exec(path)) && method === "GET") {
      const p = jobs.jobFile(m[1], m[2])
      if (!p) return err("File not found", 404)
      return fileResponse(p, url.searchParams.has("download") ? { "content-disposition": `attachment; filename="${m[1]}-${m[2]}"` } : {})
    }
    return err("Not found", 404)
  }

  const staticFile = (path: string): Response => {
    if (!config.uiDir) return err("Not found", 404)
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "")
    let file = join(config.uiDir, rel || "index.html")
    if (!file.startsWith(config.uiDir + sep) && file !== config.uiDir) return err("Not found", 404)
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.uiDir, "index.html")
    if (!existsSync(file)) return err("The UI has not been built. Run `bun run build`.", 500)
    return fileResponse(file, file.endsWith("index.html") ? { "cache-control": "no-cache" } : {})
  }

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, url.pathname, url)
      if (req.method !== "GET" && req.method !== "HEAD") return err("Not found", 404)
      return staticFile(url.pathname)
    } catch (e: any) {
      return err(e?.message ?? String(e), 500)
    }
  }

  /** Terminates every engine process (called when the desktop app quits). */
  const shutdown = () => {
    jobs.killAll()
    mesh.stop()
  }

  return { handle, engines, jobs, mesh, shutdown }
}
