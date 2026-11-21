export interface AppConfig {
  /** Writable directory for jobs, settings and the downloaded engine */
  dataDir: string
  /** Directory containing run_sim.py and the Dockerfile */
  engineDir: string
  /** Directory containing the bundled *.circuit.json examples */
  examplesDir: string
  /** Built UI (index.html + assets); omitted when a dev server provides the UI */
  uiDir?: string
  /** Read-only app resources; may contain a bundled openems-engine */
  resourcesDir?: string
}
