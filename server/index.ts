/** Development server: Bun bundles the UI on the fly with hot reloading. */
import index from "../src/ui/index.html"
import { createApp } from "./app"
import { repoConfig } from "./paths"

const app = createApp({ ...repoConfig(), uiDir: undefined })

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3090),
  hostname: process.env.HOST ?? "127.0.0.1",
  idleTimeout: 120,
  maxRequestBodySize: 512 * 1024 * 1024,
  development: { hmr: true, console: false },
  routes: { "/": index },
  fetch: (req) => app.handle(req),
})

console.log(`openEMS GUI (dev) running at ${server.url}`)
app.engines.detect().then((e) => console.log(`engine: ${e.label}`))
