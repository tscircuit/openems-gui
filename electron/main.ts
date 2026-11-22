/**
 * Desktop shell. Runs the same HTTP app as the web version on a private
 * localhost port inside Electron's main process and points a window at it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, shell } from "electron"
import type { AppConfig } from "../server/config"
import { startServer } from "../server/node-http"

// Fixed, product-name independent data directory (install.sh pre-seeds the engine here):
//   macOS ~/Library/Application Support/openems-gui, Linux ~/.config/openems-gui, Windows %APPDATA%\openems-gui
app.setName("openEMS GUI")
const dataDir = process.env.OPENEMS_GUI_DATA ?? join(app.getPath("appData"), "openems-gui")
mkdirSync(dataDir, { recursive: true })
app.setPath("userData", join(dataDir, "electron"))

// `electron .` from a checkout: the app path is the repository root
const resources = app.isPackaged ? process.resourcesPath : resolve(app.getAppPath())
const config: AppConfig = {
  dataDir,
  engineDir: join(resources, "engine"),
  examplesDir: join(resources, "examples"),
  uiDir: app.isPackaged ? join(resources, "ui") : join(resources, "dist", "ui"),
  resourcesDir: resources,
}

let win: BrowserWindow | null = null
let serverUrl = ""
let stopSimulations = () => {}

const createWindow = () => {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: "openEMS GUI",
    backgroundColor: "#0d0d0d",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.once("ready-to-show", () => win?.show())
  win.on("closed", () => (win = null))
  // anything that is not the app itself opens in the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(serverUrl)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
  win.loadURL(serverUrl)
}

const buildMenu = () => {
  const openFile = () => win?.webContents.executeJavaScript(`document.querySelector('input[type=file]')?.click()`, true)
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Circuit JSON…", accelerator: "CmdOrCtrl+O", click: openFile },
        { label: "Show Simulation Data", click: () => shell.openPath(join(dataDir, "jobs")) },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "openEMS GUI on GitHub", click: () => shell.openExternal("https://github.com/tscircuit/openems-gui") },
        { label: "openEMS documentation", click: () => shell.openExternal("https://docs.openems.de/") },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Test hook: OPENEMS_GUI_SCREENSHOT=<png> saves a screenshot once the UI has loaded, then quits. */
const selfTest = async () => {
  const out = process.env.OPENEMS_GUI_SCREENSHOT
  if (!out || !win) return
  const script = process.env.OPENEMS_GUI_SELFTEST_JS
  win.webContents.setBackgroundThrottling(false) // keep painting when the window is covered
  await new Promise((r) => setTimeout(r, Number(process.env.OPENEMS_GUI_SCREENSHOT_DELAY ?? 2500)))
  if (script) await win.webContents.executeJavaScript(script, true).catch((e) => console.error("selftest script failed:", e))
  if (script) await new Promise((r) => setTimeout(r, Number(process.env.OPENEMS_GUI_SCREENSHOT_DELAY ?? 2500)))
  win.webContents.invalidate()
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage()
  writeFileSync(out, image.toPNG())
  const engine = await fetch(`${serverUrl}api/engine`).then((r) => r.json())
  console.log(`SELFTEST title=${JSON.stringify(win.getTitle())} engine=${JSON.stringify(engine.label)} mode=${engine.mode} screenshot=${out}`)
  app.quit()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(async () => {
    try {
      if (!existsSync(join(config.uiDir!, "index.html"))) throw new Error(`UI bundle not found at ${config.uiDir}`)
      const server = await startServer(config, { port: Number(process.env.OPENEMS_GUI_PORT ?? 0) })
      serverUrl = server.url
      stopSimulations = () => server.app.shutdown()
      buildMenu()
      createWindow()
      win?.webContents.once("did-finish-load", selfTest)
    } catch (e: any) {
      console.error(e)
      if (!process.env.OPENEMS_GUI_SCREENSHOT) dialog.showErrorBox("openEMS GUI could not start", e?.stack ?? String(e))
      app.exit(1)
    }
  })
  // do not leave solver processes running after the app is gone
  app.on("before-quit", () => stopSimulations())
  app.on("activate", () => {
    if (!win && serverUrl) createWindow()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
