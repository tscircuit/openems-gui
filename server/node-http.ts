/** Serves the app over node:http. Used by the desktop app and by `bun run start`. */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Readable } from "node:stream"
import { createApp } from "./app"
import type { AppConfig } from "./config"

export const startServer = async (config: AppConfig, opts: { port?: number; host?: string } = {}) => {
  const app = createApp(config)
  const host = opts.host ?? "127.0.0.1"
  const server = createServer(async (req, res) => {
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD"
      const request = new Request(`http://${req.headers.host ?? host}${req.url ?? "/"}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
        // @ts-expect-error duplex is required by Node for streaming request bodies
        duplex: hasBody ? "half" : undefined,
      })
      const response = await app.handle(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body || req.method === "HEAD") return void res.end()
      Readable.fromWeb(response.body as any)
        .on("error", () => res.destroy())
        .pipe(res)
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: e?.message ?? String(e) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, host, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return { app, port, url: `http://${host}:${port}/`, close: () => new Promise<void>((r) => server.close(() => r())) }
}
