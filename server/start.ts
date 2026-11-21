/** Production web server: `bun run build && bun run start` (also runs under Node). */
import { startServer } from "./node-http"
import { repoConfig } from "./paths"

const server = await startServer(repoConfig(), { port: Number(process.env.PORT ?? 3090), host: process.env.HOST ?? "127.0.0.1" })
console.log(`openEMS GUI running at ${server.url}`)
server.app.engines.detect().then((e) => console.log(`engine: ${e.label}`))
