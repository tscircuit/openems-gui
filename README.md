# openEMS GUI

A desktop app that turns a [Circuit JSON](https://github.com/tscircuit/circuit-json) PCB into an
[openEMS](https://www.openems.de/) FDTD simulation: load a board, click to place ports, configure, run, and
read S-parameters, impedance and antenna patterns.

## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/tscircuit/openems-gui/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/tscircuit/openems-gui/main/install.ps1 | iex
```

The installer puts the app in `/Applications` (macOS) or `~/.local/share/openems-gui` with an `openems-gui`
launcher in `~/.local/bin` (Linux), and downloads a self-contained openEMS so simulations work straight away.
No `sudo`, nothing installed system-wide. Set `OPENEMS_GUI_SKIP_ENGINE=1` to skip the engine download,
`OPENEMS_GUI_VERSION=v0.1.0` to pin a release.

Installers for manual download are on the [releases page](https://github.com/tscircuit/openems-gui/releases).

## The openEMS engine

The app needs openEMS on the same computer. It looks for one in this order and shows what it found in the
engine menu (top right), where you can switch:

| Engine | What it is |
| --- | --- |
| Custom | the Python named by `$OPENEMS_PYTHON` |
| Bundled | an `openems-engine` folder shipped inside the app's resources |
| **Downloaded** | a prebuilt, self-contained openEMS 0.37 (Python, CSXCAD, openEMS, all libraries) that the app or the installer downloads into the app data folder — macOS arm64/x64 and Linux x64/arm64 |
| Installed | an openEMS you installed yourself: any `python3` on `PATH` (or `~/opt/openEMS/venv`) that can `import openEMS` |
| Docker | the `openems-gui-engine` image, built from `engine/Dockerfile` (the route for Windows today) |

The downloaded engine is about 80–100 MB (270–350 MB unpacked). The Linux build needs glibc 2.35 or newer
(Ubuntu 22.04, Debian 12, Fedora 36 and later); on older systems the app falls back to an installed openEMS
or Docker. There is no prebuilt engine for Windows yet.

App data (downloaded engine, simulation runs, settings) lives in `~/Library/Application Support/openems-gui`
(macOS), `~/.config/openems-gui` (Linux) or `%APPDATA%\openems-gui` (Windows).

## Workflow

1. **Load** a Circuit JSON file (drop it on the window, *File → Open Circuit JSON…*, or pick an example).
2. **Board & ports**: place ports by clicking the board:
   - click a pad (or any copper) → *Add port to plane*: a vertical lumped port from that point to a reference
     layer (the usual microstrip / probe feed);
   - click a pad → *Add port between this pad and another…* → click the second pad: a lumped port across a
     gap, e.g. an antenna feed gap or in place of a component.
   Tick *Excite* on every port that should drive a run; each excited port is one FDTD run and one column of
   the S-matrix.
3. **Configure** (sidebar) the frequency band, substrate (εr, tan δ, thickness), copper model, end criterion,
   which fields to record, the far field, and an optional sub-region of the board.
4. **Mesh** tab: cell sizes, boundaries and air margins, with a 3D view of the board and the mesh lines.
   *Build mesh in openEMS* runs only openEMS's grid construction (the step every simulation starts with, and
   the slow one on large boards) and reports how long it took, the exact timestep, the length of the
   excitation pulse in timesteps and the memory needed. It also draws the metal edges exactly where openEMS
   placed them on the grid, which is how you spot a trace that fell between cells or a gap that closed.
5. **Run**. The solver log streams into the *Solver log* tab; *Finish now* stops time-stepping but still
   post-processes, *Abort* kills the engine.
6. **Results**, in three views:
   - *Frequency domain*: S-parameters (dB / phase / VSWR), Smith chart, input impedance, directivity cuts and
     efficiency, Touchstone export, and the raw `results.json` / `sim.json` / `geometry.xml` (CSXCAD).
   - *Time domain*: step response of every path for an edge with a chosen rise time, propagation delay and
     skew between paths, crosstalk peak, TDR impedance profile and group delay, all computed from the
     S-parameters. Start the band at 0 GHz for these.
   - *3D fields*: the recorded E and H fields as slices through the board (horizontal and two vertical cuts
     you can move), per frequency with the phase animated, or as a movie of the excitation pulse travelling
     along the copper; and the antenna's 3D radiation pattern.

Every run is kept with its circuit, settings, log and results; the *Runs* menu reopens them and ↺ restores a
run's board and settings.

### What it is for

| Task | Where |
| --- | --- |
| Is this trace / feed matched? Return loss, VSWR, input impedance | Frequency domain, Smith chart |
| Characteristic impedance along a route, discontinuities at vias, stubs, plane gaps | Time domain → TDR impedance profile |
| Propagation delay, length-matching and skew between nets (DDR, clock trees) | Time domain → delay and skew table |
| Crosstalk between neighbouring traces (near and far end) | S31 / S41 in the frequency domain, crosstalk peak in the time domain |
| Filter, coupler and divider response | S-parameters, Touchstone export |
| Antenna tuning: resonance, bandwidth, gain, efficiency, pattern | Frequency domain, far field, 3D pattern |
| Where does the current / field go? Return paths, coupling between serpentine legs, slots, radiation from edges | 3D fields (H just above a plane shows the return current) |
| Will this simulation fit and how long will it take? | Mesh tab |

Not covered yet: mixed-mode (differential / common-mode) S-parameters, eye diagrams, waveguide (wave) ports
and de-embedding, lossy or dispersive dielectric models beyond a constant loss tangent, parameter sweeps.

## Examples

Built with tscircuit (`examples/build-examples.tsx`) and bundled with the app, each with a ready-made
setup. The numbers are what the bundled setup simulates.

| Example | Simulated result |
| --- | --- |
| Bad DDR: DQ0 length-matched to its DQS strobe with a tight serpentine (0.2 mm between legs) | DQ0 arrives 13.0 ps before DQS; TDR dips from 44 Ω to 37 Ω in the serpentine |
| Good DDR: the same board with the serpentine legs 1.2 mm apart (3 trace widths) | DQ0 within 1.2 ps of DQS; TDR within 2 Ω |
| 2.4 GHz Wi-Fi / BLE inverted-F antenna, 25 × 45 mm module board | \|S11\| ≤ −19 dB over 2.40–2.4835 GHz, 2.8 dBi, 95 % efficiency |
| 2.4 GHz three-pole hairpin band-pass filter on FR-4 | 2.5–3.4 dB loss over 2.30–2.55 GHz, 31 / 24 dB rejection at 1.5 / 3.5 GHz |
| 2.4 GHz Wilkinson divider with a 100 Ω 0603 resistor | S21 = S31 = −3.5 dB, S11 −18.6 dB, isolation −28 dB |
| 50 Ω microstrip line | ≈ 49 Ω, S21 ≈ −0.4 dB |
| 2.4 GHz patch antenna, probe fed | −31 dB match at 2.335 GHz, 6.4 dBi, 51 % efficiency |
| LC low-pass filter (0603 parts as lumped elements, GND vias) | −3 dB at ≈ 1.1 GHz |

The two DDR boards model the top layer over the L2 plane of a 4-layer board (0.2 mm dielectric, 0.4 mm
traces, 30 × 8 mm) and are identical apart from the serpentine pitch: same pads, routed length, number of
humps and corners. Open *Results → Time domain* for the delay and skew table and the TDR, and *3D fields* to
watch the pulse run down both nets. Two things they also show: a square corner is electrically about 0.17 mm
(1.1 ps) shorter than its centre line, so both boards route DQ0 2 mm longer than DQS to make up for its twelve
corners (without that even the well spaced serpentine arrives 13.6 ps early); and the 0.4 mm trace comes out
at 44–45 Ω on this mesh rather than the 49 Ω of the closed-form formula.

## What gets simulated

| Circuit JSON | openEMS model |
| --- | --- |
| `pcb_board` (size, thickness, `num_layers`) | substrate box; copper layers evenly spaced through the thickness |
| `pcb_smtpad`, `pcb_plated_hole`, `pcb_trace`, `pcb_via`, `pcb_copper_pour` | zero-thickness copper polygons per layer (PEC or lossy conducting sheet); pour cut-outs are honoured |
| via and plated-hole barrels | PEC cylinders plus a wire on a mesh line |
| two-pad `simple_resistor` / `simple_capacitor` / `simple_inductor` | lumped R / C / L between the facing pad edges (optional); 0 Ω becomes a copper bridge |
| everything else (chips, connectors) | pads only — left open |

Recorded fields are relative, not absolute (the excitation amplitude is arbitrary), are sub-sampled to at
most about 250 000 points per frequency, and are stored with 16-bit resolution. The time-domain recording
is written for the whole run, so a long-ringing simulation produces a lot of temporary data.

Limits worth knowing: copper has no thickness, dielectric loss uses a constant conductivity fitted at the
band centre, custom board outlines are simulated as their bounding rectangle, solder mask is ignored, and
rounded pad corners are squared off.

## Development

```bash
bun install
bun run dev        # web UI with hot reload at http://127.0.0.1:3090
bun run desktop    # build and open the Electron app
bun test && bun run typecheck
```

```
electron/    Electron main process: starts the local server, opens the window
server/      HTTP API (fetch Request/Response; runs under Bun, Node and Electron):
             engine detection / download, job runner, log and progress parsing
src/lib/     circuit JSON → geometry (extract.ts), mesher (mesh.ts), job builder (build-sim.ts),
             step response / TDR / delay from S-parameters (timedomain.ts)
src/ui/      React UI: board view, config panel, mesh tab, 3D viewer (three.js), charts
engine/      run_sim.py (reads sim.json, drives openEMS, writes results.json and the field files;
             `--mesh` only builds the grid), build-engine.sh (builds the downloadable engine
             bundle), Dockerfile
examples/    tscircuit sources for the bundled examples (`bun run examples` regenerates them)
scripts/     make-job.ts builds a job dir headlessly; show-results.py prints a results table
install.sh   one-line installer (macOS, Linux); install.ps1 for Windows
```

Headless run of an example with any engine Python:

```bash
bun scripts/make-job.ts wifi-ifa jobs/cli-ifa
/path/to/openems-engine/bin/python3 engine/run_sim.py jobs/cli-ifa
python3 scripts/show-results.py jobs/cli-ifa
```

Environment: `PORT` (default 3090), `HOST`, `OPENEMS_PYTHON`, `OPENEMS_ENGINE`
(`custom|bundled|managed|installed|docker` to force one), `OPENEMS_ENGINE_URL` (engine bundle URL or local
`.tar.gz`), `OPENEMS_GUI_DATA` (data directory).

## Building and releasing

**Engine bundles.** `engine/build-engine.sh` builds openEMS from source against conda-forge libraries in a
private prefix (via micromamba, nothing system-wide), strips everything the engine does not link to, runs a
real simulation from a relocated copy, and writes `dist-engine/openems-engine-<platform>.tar.gz`. The
*Engine bundles* workflow runs it on macOS arm64/x64 and Linux x64/arm64 and uploads the results to the
prerelease named by `ENGINE_RELEASE_TAG` in `server/engine-release.ts` (`install.sh` carries the same tag; a
test keeps them in sync). Bump the tag when the bundle changes.

**App.** `bun run dist` packages the Electron app for the current platform into `release/`. Pushing a
`v*` tag runs the *Release* workflow, which builds macOS, Linux and Windows installers and attaches them to
the GitHub release that the install scripts download from. The macOS build is ad-hoc signed, not notarized:
the install script works as is, while a manually downloaded `.dmg` needs right-click → Open the first time.

## Licence

The app is MIT licensed. openEMS itself is GPL-3.0 (CSXCAD and fparser LGPL-3.0); the app runs it as a
separate program, and the downloadable engine bundles are built from unmodified upstream sources by
`engine/build-engine.sh` (each bundle carries a `NOTICE.txt` with the exact versions and source links).
`engine/run_sim.py`, which imports the openEMS Python modules, may also be used under GPL-3.0-or-later.
