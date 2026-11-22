import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../server/app"
import { startServer } from "../server/node-http"

const root = join(import.meta.dir, "..")
const dataDir = mkdtempSync(join(tmpdir(), "openems-gui-test-"))
const uiDir = join(dataDir, "ui")
mkdirSync(uiDir)
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>test ui</title>")
writeFileSync(join(uiDir, "app.js"), "console.log(1)")
const config = { dataDir, engineDir: join(root, "engine"), examplesDir: join(root, "examples"), uiDir }
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const app = createApp(config)
const get = (path: string) => app.handle(new Request(`http://localhost${path}`))

test("lists and serves the bundled examples", async () => {
  const list = (await (await get("/api/examples")).json()) as Array<{ id: string }>
  expect(list.length).toBeGreaterThanOrEqual(3)
  for (const ex of list) {
    const res = await get(`/api/examples/${ex.id}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  }
  expect((await get("/api/examples/nope")).status).toBe(404)
})

test("serves the UI with an index.html fallback and refuses to leave the UI directory", async () => {
  expect(await (await get("/")).text()).toContain("test ui")
  expect((await get("/app.js")).headers.get("content-type")).toContain("javascript")
  expect(await (await get("/some/client/route")).text()).toContain("test ui")
  const escape = await get("/..%2F..%2Fpackage.json")
  expect(await escape.text()).not.toContain('"electron-builder"')
})

test("job endpoints validate input and ids", async () => {
  expect(await (await get("/api/jobs")).json()).toEqual([])
  expect((await get("/api/jobs/does-not-exist")).status).toBe(404)
  expect((await get("/api/jobs/x/files/..%2Fsettings.json")).status).toBe(404)
  const bad = await app.handle(new Request("http://localhost/api/jobs/x/stop", { method: "POST", body: "{}" }))
  expect(bad.status).toBe(409)
})

test("mesh build endpoints report an idle state and validate input", async () => {
  const state = (await (await get("/api/mesh")).json()) as { status: string; log: string[] }
  expect(state.status).toBe("idle")
  expect((await get("/api/mesh/pec")).status).toBe(404)
  // stopping when nothing runs is harmless
  expect((await app.handle(new Request("http://localhost/api/mesh", { method: "DELETE" }))).status).toBe(200)
  expect(() => app.mesh.start({} as any, "k", { active: null } as any)).toThrow("Invalid simulation input")
  app.shutdown()
})

test("engine preference is validated and persisted", async () => {
  const post = (kind: string) => app.handle(new Request("http://localhost/api/engine/prefer", { method: "POST", body: JSON.stringify({ kind }) }))
  expect((await post("bogus")).status).toBe(400)
  const info = (await (await post("docker")).json()) as { preferred: string; candidates: Array<{ kind: string }>; platform: string }
  expect(info.preferred).toBe("docker")
  expect(info.candidates.map((c) => c.kind)).toEqual(expect.arrayContaining(["managed", "installed", "docker"]))
  expect(info.platform).toBe(`${process.platform}-${process.arch}`)
}, 60000)

test("the node:http adapter serves the same app", async () => {
  const server = await startServer(config, { port: 0 })
  try {
    const res = await fetch(`${server.url}api/examples`)
    expect(res.status).toBe(200)
    expect(await (await fetch(server.url)).text()).toContain("test ui")
    const posted = await fetch(`${server.url}api/engine/prefer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "auto" }) })
    expect(((await posted.json()) as { preferred: string }).preferred).toBe("auto")
  } finally {
    await server.close()
  }
}, 60000)
