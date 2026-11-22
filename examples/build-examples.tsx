/**
 * Generates the bundled example circuit JSON files with tscircuit.
 *   bun run examples            # all
 *   bun examples/build-examples.tsx wifi-ifa
 *
 * The RF examples (IFA, hairpin filter, Wilkinson divider) are printed copper structures. They are drawn as
 * a <chip> whose custom <footprint> is a set of rectangular SMT pads: overlapping / abutting pads of one
 * footprint merge into one conductor in the simulation. All their dimensions sit on a 0.25 mm grid so that
 * copper edges coincide with FDTD mesh lines (0.1 mm for the DDR serpentine pair). The parameter objects hold
 * the values that were tuned with openEMS; the builders take overrides so a tuning script can sweep them.
 */
import { Fragment, createElement } from "react"
import { Circuit } from "tscircuit"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const FeedPad = (props: { name: string; pcbX: number; pcbY: number; size?: number; net?: string }) => (
  <chip
    name={props.name}
    pcbX={props.pcbX}
    pcbY={props.pcbY}
    connections={props.net ? { pin1: `net.${props.net}` } : undefined}
    footprint={
      <footprint>
        <smtpad
          portHints={["pin1"]}
          shape="rect"
          width={`${props.size ?? 3}mm`}
          height={`${props.size ?? 3}mm`}
          pcbX={0}
          pcbY={0}
        />
      </footprint>
    }
  />
)

/** A copper rectangle given by its edges (mm), belonging to footprint pin `pin`. */
type Cu = { pin: string; x0: number; y0: number; x1: number; y1: number }
const cu = (pin: string, xa: number, ya: number, xb: number, yb: number): Cu => ({
  pin,
  x0: Math.min(xa, xb),
  y0: Math.min(ya, yb),
  x1: Math.max(xa, xb),
  y1: Math.max(ya, yb),
})
const r3 = (v: number) => Math.round(v * 1000) / 1000
/** Children passed as varargs, so a generated list needs no React keys. */
const list = (els: any[]) => createElement(Fragment, null, ...els)
const copperPads = (rects: Cu[]) =>
  rects.map((r) => (
    <smtpad
      portHints={[r.pin]}
      shape="rect"
      width={`${r3(r.x1 - r.x0)}mm`}
      height={`${r3(r.y1 - r.y0)}mm`}
      pcbX={r3((r.x0 + r.x1) / 2)}
      pcbY={r3((r.y0 + r.y1) / 2)}
    />
  ))
/** Printed (etched) structure: a chip that is only copper, placed at the board origin. */
const PrintedCopper = (props: { name: string; rects: Cu[]; connections?: Record<string, string> }) => (
  <chip name={props.name} pcbX={0} pcbY={0} doNotPlace connections={props.connections} footprint={<footprint>{list(copperPads(props.rects))}</footprint>} />
)

// ---------------------------------------------------------------------------------------------------------
// 2.4 GHz inverted-F antenna on a 25 x 45 mm module-style board
// ---------------------------------------------------------------------------------------------------------
export const ifaDefaults = {
  boardW: 25,
  boardH: 45,
  thickness: 1.6,
  /** copper-free strip at the top (+y) end of the board that holds the antenna */
  keepout: 7,
  /** pull-back of ground copper and antenna from the board edge */
  edge: 0.25,
  /** distance of the antenna from the top / left board edges */
  antEdge: 0.5,
  /** strip width of arm, shorting stub and feed stub */
  w: 1,
  /** arm length, measured from the outer edge of the shorting stub to the open end */
  armLen: 21,
  /** the open end is folded back towards the ground by this much (0 = plain IFA) */
  tipDrop: 0,
  /** centre-to-centre distance between shorting stub and feed stub */
  feedOffset: 4,
  /** gap between the bottom of the feed stub and the ground edge; the 50 ohm port sits across it */
  feedGap: 0.5,
  /** stitching vias: spacing along the antenna-side ground edge and around the rest of the perimeter */
  viaPitchEdge: 2,
  viaPitch: 5,
}
export type IfaParams = typeof ifaDefaults

export const wifiIfa = (over: Partial<IfaParams> = {}) => {
  const p = { ...ifaDefaults, ...over }
  const hw = p.boardW / 2
  const hh = p.boardH / 2
  const yg = hh - p.keepout // ground edge facing the antenna
  const armTop = hh - p.antEdge
  const xs = -hw + p.antEdge // outer (left) edge of the shorting stub
  const xf = xs + p.w / 2 + p.feedOffset // feed stub centre
  const armEnd = xs + p.armLen
  const rects: Cu[] = [
    // pin1 FEED: feed stub, from the arm down to feedGap above the ground edge
    cu("pin1", xf - p.w / 2, yg + p.feedGap, xf + p.w / 2, armTop - p.w),
    // pin2 GND: return pad of the feed, on the ground edge straight below the feed stub (port = pin1 <-> pin2)
    cu("pin2", xf - p.w / 2, yg - 1, xf + p.w / 2, yg),
    // pin3 GND: foot of the shorting stub, inside the ground pour
    cu("pin3", xs, yg - 1, xs + p.w, yg),
    // pin4 radiator: shorting stub + arm (+ optional folded tip)
    cu("pin4", xs, yg, xs + p.w, armTop),
    cu("pin4", xs, armTop - p.w, armEnd, armTop),
  ]
  if (p.tipDrop > 0) rects.push(cu("pin4", armEnd - p.w, armTop - p.w - p.tipDrop, armEnd, armTop))

  // Ground on both layers below the keep-out, stitched together with vias. The pour outline is given
  // explicitly (boardEdgeMargin 0) so its antenna-side edge is exactly at yg.
  const gx = hw - p.edge
  const ground = [
    { x: -gx, y: -hh + p.edge },
    { x: gx, y: -hh + p.edge },
    { x: gx, y: yg },
    { x: -gx, y: yg },
  ]
  // via positions are snapped to the 0.5 mm grid
  const snap = (v: number) => Math.round(v * 2) / 2
  const row = (a: number, b: number, pitch: number) => {
    const n = Math.max(1, Math.round((b - a) / pitch))
    return Array.from({ length: n + 1 }, (_, i) => snap(a + ((b - a) * i) / n))
  }
  const vx = hw - 1.5
  const yTop = yg - 1.5
  const yBot = -hh + 1.5
  const vias: { x: number; y: number }[] = []
  for (const x of row(-vx, vx, p.viaPitchEdge)) vias.push({ x, y: yTop })
  for (const x of row(-vx, vx, p.viaPitch)) vias.push({ x, y: yBot })
  for (const y of row(yBot, yTop, p.viaPitch).slice(1, -1)) vias.push({ x: -vx, y }, { x: 0, y }, { x: vx, y })
  return (
    <board width={`${p.boardW}mm`} height={`${p.boardH}mm`} thickness={`${p.thickness}mm`} placementDrcChecksDisabled>
      <PrintedCopper name="ANT1" rects={rects} connections={{ pin2: "net.GND", pin3: "net.GND" }} />
      {list(
        vias.map((v, i) => (
          <via name={`VG${i + 1}`} pcbX={r3(v.x)} pcbY={r3(v.y)} fromLayer="top" toLayer="bottom" holeDiameter="0.3mm" outerDiameter="0.6mm" connectsTo="net.GND" />
        )),
      )}
      <copperpour layer="top" connectsTo="net.GND" outline={ground} boardEdgeMargin={0} />
      <copperpour layer="bottom" connectsTo="net.GND" outline={ground} boardEdgeMargin={0} />
    </board>
  )
}

// ---------------------------------------------------------------------------------------------------------
// 2.4 GHz three-pole tapped hairpin band-pass filter
// ---------------------------------------------------------------------------------------------------------
export const hairpinDefaults = {
  boardW: 40,
  boardH: 28,
  thickness: 1.6,
  /** resonator strip width */
  w: 1.5,
  /** spacing between the two arms of one hairpin */
  armSpacing: 3,
  /** outer length of the hairpin arms (open end to outer edge of the bend) */
  armLen: 16.75,
  /** the middle hairpin is longer by this much: its two neighbours detune it upwards */
  midExtra: 0.5,
  /** gap between neighbouring hairpins */
  gap: 1.25,
  /** centre of the 50 ohm feed tap, measured from the outer edge of the bend along the outer arm */
  tap: 4,
  /** 50 ohm feed line width */
  feedW: 3,
  /** x of the two port pads */
  portX: 17,
}
export type HairpinParams = typeof hairpinDefaults

export const hairpinBpf = (over: Partial<HairpinParams> = {}) => {
  const p = { ...hairpinDefaults, ...over }
  const wh = 2 * p.w + p.armSpacing // outer width of one hairpin
  const pitch = wh + p.gap
  const y0 = -Math.ceil(p.armLen / 2 / 0.25) * 0.25 // bend edge of the outer hairpins, kept on the 0.25 mm grid
  const y1 = y0 + p.armLen
  /** hairpin centred at cx; `up` = open ends at +y (bend at the bottom) */
  const hairpin = (pin: string, cx: number, up: boolean, extra = 0): Cu[] => {
    const bendA = up ? y0 : y1
    const bendB = up ? y0 + p.w : y1 - p.w
    const openEnd = up ? y1 + extra : y0 - extra
    return [
      cu(pin, cx - wh / 2, bendA, cx - wh / 2 + p.w, openEnd),
      cu(pin, cx + wh / 2 - p.w, bendA, cx + wh / 2, openEnd),
      cu(pin, cx - wh / 2, bendA, cx + wh / 2, bendB),
    ]
  }
  const yTap = y0 + p.tap
  const xOuter = pitch + wh / 2
  const rects: Cu[] = [
    ...hairpin("pin1", -pitch, true),
    ...hairpin("pin2", 0, false, p.midExtra),
    ...hairpin("pin3", pitch, true),
    // tapped 50 ohm feeds
    cu("pin1", -p.portX - p.feedW / 2, yTap - p.feedW / 2, -xOuter, yTap + p.feedW / 2),
    cu("pin3", xOuter, yTap - p.feedW / 2, p.portX + p.feedW / 2, yTap + p.feedW / 2),
  ]
  return (
    <board width={`${p.boardW}mm`} height={`${p.boardH}mm`} thickness={`${p.thickness}mm`} placementDrcChecksDisabled>
      <FeedPad name="P1" pcbX={-p.portX} pcbY={r3(yTap)} size={p.feedW} />
      <FeedPad name="P2" pcbX={p.portX} pcbY={r3(yTap)} size={p.feedW} />
      <PrintedCopper name="BPF1" rects={rects} />
      <copperpour layer="bottom" connectsTo="net.GND" />
    </board>
  )
}

// ---------------------------------------------------------------------------------------------------------
// 2.4 GHz Wilkinson power divider with a 100 ohm 0603 isolation resistor
// ---------------------------------------------------------------------------------------------------------
export const wilkinsonDefaults = {
  boardW: 32,
  boardH: 30,
  thickness: 1.6,
  /** 50 ohm line width */
  w50: 3,
  /** 70.7 ohm quarter-wave arm width */
  w70: 1.5,
  /** x of the splitting junction (centre of the vertical bar) */
  xJ: -6,
  /** half height of the arm loop: y of the centreline of the horizontal arm sections */
  loopY: 6,
  /** horizontal length of the arm loop (junction bar centre to resistor column centre) */
  loopX: 11.25,
  /** the arms end this far from the board centreline; the 0603 resistor bridges the 2 x resGap opening */
  resGap: 0.5,
  /** inner edge (|y|) of the 50 ohm output lines where they leave the arm ends */
  outY: 1,
  /** the output lines run to the top / bottom ports this far to the right of the resistor column */
  outDx: 4.5,
  portX: -14,
  portY: 12,
}
export type WilkinsonParams = typeof wilkinsonDefaults

export const wilkinsonDivider = (over: Partial<WilkinsonParams> = {}) => {
  const p = { ...wilkinsonDefaults, ...over }
  const h7 = p.w70 / 2
  const h5 = p.w50 / 2
  const xR = p.xJ + p.loopX // resistor column
  const outX = xR + p.outDx // centre of the output lines
  const rects: Cu[] = [
    // input 50 ohm line and the junction bar that starts both arms
    cu("pin1", p.portX - h5, -h5, p.xJ, h5),
    cu("pin1", p.xJ - h7, -p.loopY - h7, p.xJ + h7, p.loopY + h7),
  ]
  for (const s of [1, -1]) {
    const pin = s > 0 ? "pin2" : "pin3"
    rects.push(
      // 70.7 ohm arm: horizontal section, then back down to the resistor
      cu("pin1", p.xJ - h7, s * (p.loopY - h7), xR + h7, s * (p.loopY + h7)),
      cu("pin1", xR - h7, s * p.resGap, xR + h7, s * (p.loopY + h7)),
      // 50 ohm output: leaves the arm end sideways, then runs to the port at the board edge
      cu(pin, xR + h7, s * p.outY, outX + h5, s * (p.outY + p.w50)),
      cu(pin, outX - h5, s * p.outY, outX + h5, s * (p.portY + h5)),
    )
  }
  return (
    <board width={`${p.boardW}mm`} height={`${p.boardH}mm`} thickness={`${p.thickness}mm`} placementDrcChecksDisabled>
      <FeedPad name="P1" pcbX={p.portX} pcbY={0} size={p.w50} />
      <FeedPad name="P2" pcbX={outX} pcbY={p.portY} size={p.w50} />
      <FeedPad name="P3" pcbX={outX} pcbY={-p.portY} size={p.w50} />
      <PrintedCopper name="DIV1" rects={rects} />
      {/* isolation resistor across the opening between the two arm ends; its pads overlap the arm copper */}
      <resistor name="R1" resistance="100" footprint="0603" pcbX={xR} pcbY={0} pcbRotation={90} />
      <copperpour layer="bottom" connectsTo="net.GND" />
    </board>
  )
}

// ---------------------------------------------------------------------------------------------------------
// DDR length matching: a straight strobe (DQS) and a data line (DQ0) whose serpentine makes up the same
// routed length. "Bad" and "Good" are the same board, the same pads and the same serpentine (humps, amplitude,
// corners, centre-line length); only the gap between neighbouring serpentine legs differs.
// ---------------------------------------------------------------------------------------------------------
export const ddrDefaults = {
  boardW: 30,
  boardH: 8,
  /** L1 to the L2 ground plane of a 4-layer stack-up, modelled as a 2-layer board of this thickness */
  thickness: 0.2,
  /** trace width (about 49 ohm on 0.2 mm FR-4) */
  w: 0.4,
  /** routed centre-line length of both nets, port to port */
  len: 26,
  /**
   * Corner compensation: DQ0 is routed this much longer than DQS. A square corner is electrically about
   * 0.17 mm (0.43 trace widths, 1.07 ps) shorter than its centre line, and DQ0 has twelve of them. With 0
   * (plain centre-line matching) even the well spaced serpentine arrives 13.6 ps early.
   */
  dqExtra: 2,
  /** the DQ0 ports sit at x = -dqPadX and +dqPadX; the serpentine has to make up len + dqExtra - 2 dqPadX */
  dqPadX: 8,
  /** number of serpentine humps (each one is two legs and four right-angle corners) */
  humps: 3,
  /** centre-line height of a hump */
  amp: 2,
  /** edge-to-edge gap between neighbouring serpentine legs: the only thing Bad and Good differ in */
  gap: 1.2,
  /** centre-line y of the straight DQS trace and of the DQ0 base line (the humps point away from DQS) */
  yDqs: -2,
  yDq: 0,
}
export type DdrParams = typeof ddrDefaults

/** Centre-line corner points of the DQ0 route and the resulting copper, exported for the tuning scripts. */
export const ddrGeometry = (over: Partial<DdrParams> = {}) => {
  const p = { ...ddrDefaults, ...over }
  const hw = p.w / 2
  const pitch = p.w + p.gap
  const legs = 2 * p.humps
  const legX = Array.from({ length: legs }, (_, k) => r3((k - (legs - 1) / 2) * pitch))
  // centre line: base line -> up leg -> top -> down leg -> base line -> ...
  const path: { x: number; y: number }[] = [{ x: -p.dqPadX, y: p.yDq }]
  for (let k = 0; k < legs; k++) {
    const up = k % 2 === 0
    path.push({ x: legX[k], y: up ? p.yDq : p.yDq + p.amp }, { x: legX[k], y: up ? p.yDq + p.amp : p.yDq })
  }
  path.push({ x: p.dqPadX, y: p.yDq })
  let routed = 0
  let corners = 0
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x
    const dy = path[i].y - path[i - 1].y
    if (Math.abs(dx) > 1e-9 && Math.abs(dy) > 1e-9) throw new Error("DDR serpentine: segment is not axis aligned")
    if (dx < -1e-9) throw new Error("DDR serpentine: does not fit between the DQ0 pads")
    routed += Math.abs(dx) + Math.abs(dy)
    if (i > 1) corners++
  }
  if (Math.abs(routed - (p.len + p.dqExtra)) > 1e-3)
    throw new Error(`DDR serpentine: routed DQ0 length ${routed.toFixed(4)} mm is not ${p.len + p.dqExtra} mm (2 dqPadX + 2 humps amp must equal len + dqExtra)`)
  if (legX[0] - hw < -p.dqPadX + p.w) throw new Error("DDR serpentine: no room for the lead-in between pad and first leg")
  const dqsSpacing = p.yDq - hw - (p.yDqs + hw)
  if (dqsSpacing < 1.6 - 1e-9) throw new Error(`DDR serpentine: DQS to DQ0 spacing ${dqsSpacing} mm is under 1.6 mm`)
  // every segment becomes one rectangle, widened by w/2 at both ends so that the outer corners are square
  const dq: Cu[] = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    dq.push(cu("pin2", Math.min(a.x, b.x) - hw, Math.min(a.y, b.y) - hw, Math.max(a.x, b.x) + hw, Math.max(a.y, b.y) + hw))
  }
  const dqs: Cu[] = [cu("pin1", -p.len / 2 - hw, p.yDqs - hw, p.len / 2 + hw, p.yDqs + hw)]
  const rects = [...dqs, ...dq]
  // all copper edges must lie on the 0.1 mm mesh grid
  for (const r of rects)
    for (const v of [r.x0, r.y0, r.x1, r.y1])
      if (Math.abs(v * 10 - Math.round(v * 10)) > 1e-6) throw new Error(`DDR serpentine: copper edge ${v} is off the 0.1 mm grid`)
  return { p, rects, path, routed, corners, pitch, legX, dqsSpacing }
}

export const ddrSerpentine = (over: Partial<DdrParams> = {}) => {
  const { p, rects } = ddrGeometry(over)
  return (
    <board width={`${p.boardW}mm`} height={`${p.boardH}mm`} thickness={`${p.thickness}mm`} placementDrcChecksDisabled routingDisabled>
      <FeedPad name="P1" pcbX={-p.len / 2} pcbY={p.yDqs} size={p.w} net="DQS" />
      <FeedPad name="P2" pcbX={p.len / 2} pcbY={p.yDqs} size={p.w} net="DQS" />
      <FeedPad name="P3" pcbX={-p.dqPadX} pcbY={p.yDq} size={p.w} net="DQ0" />
      <FeedPad name="P4" pcbX={p.dqPadX} pcbY={p.yDq} size={p.w} net="DQ0" />
      <PrintedCopper name="DDR1" rects={rects} connections={{ pin1: "net.DQS", pin2: "net.DQ0" }} />
      <copperpour layer="bottom" connectsTo="net.GND" />
    </board>
  )
}
/** leg-to-leg gap of the two bundled boards: 0.5 x and 3 x the trace width */
export const DDR_BAD_GAP = 0.2
export const DDR_GOOD_GAP = 1.2

// tscircuit numbers components per process and quotes those numbers in its warning messages ("<chip#31 ...>"),
// so a file built on its own and one built in an all-examples run differ in those messages and in nothing else.
export const examples: Record<string, (params?: any) => any> = {
  // 50 ohm microstrip through-line on 1.6mm FR4 with a solid bottom ground pour
  "microstrip-line": () => (
    <board width="40mm" height="20mm" thickness="1.6mm">
      <FeedPad name="P1" pcbX={-16} pcbY={0} />
      <FeedPad name="P2" pcbX={16} pcbY={0} />
      <trace
        from=".P1 > .pin1"
        to=".P2 > .pin1"
        thickness="3mm"
      />
      <copperpour layer="bottom" connectsTo="net.GND" />
    </board>
  ),
  // 2.4 GHz rectangular patch antenna, probe-fed (port placed in the GUI)
  "patch-antenna": () => (
    <board width="60mm" height="60mm" thickness="1.6mm">
      <chip
        name="ANT1"
        pcbX={0}
        pcbY={0}
        footprint={
          <footprint>
            <smtpad portHints={["pin1"]} shape="rect" width="29mm" height="38mm" pcbX={0} pcbY={0} />
          </footprint>
        }
      />
      <copperpour layer="bottom" connectsTo="net.GND" />
    </board>
  ),
  // Lumped 3rd-order low-pass (C-L-C) between two feed pads, shunt caps to GND through vias
  "lc-lowpass": () => (
    <board width="30mm" height="16mm" thickness="1.6mm" placementDrcChecksDisabled>
      <FeedPad name="P1" pcbX={-11} pcbY={0} size={2} />
      <FeedPad name="P2" pcbX={11} pcbY={0} size={2} />
      <inductor name="L1" inductance="8.2nH" footprint="0603" pcbX={0} pcbY={0} />
      <capacitor name="C1" capacitance="3.3pF" footprint="0603" pcbX={-5} pcbY={-2.5} pcbRotation={90} />
      <capacitor name="C2" capacitance="3.3pF" footprint="0603" pcbX={5} pcbY={-2.5} pcbRotation={90} />
      <trace from=".P1 > .pin1" to=".L1 > .pin1" thickness="1.2mm" />
      <trace from=".L1 > .pin2" to=".P2 > .pin1" thickness="1.2mm" />
      <trace from=".C1 > .pin2" to=".L1 > .pin1" thickness="1.2mm" />
      <trace from=".C2 > .pin2" to=".L1 > .pin2" thickness="1.2mm" />
      <via name="V1" pcbX={-5} pcbY={-3.3} fromLayer="top" toLayer="bottom" holeDiameter="0.4mm" outerDiameter="0.8mm" connectsTo="net.GND" />
      <via name="V2" pcbX={5} pcbY={-3.3} fromLayer="top" toLayer="bottom" holeDiameter="0.4mm" outerDiameter="0.8mm" connectsTo="net.GND" />
      <trace from=".C1 > .pin1" to="net.GND" />
      <trace from=".C2 > .pin1" to="net.GND" />
      <copperpour layer="bottom" connectsTo="net.GND" />
    </board>
  ),
  "bad-ddr": (params?: Partial<DdrParams>) => ddrSerpentine({ gap: DDR_BAD_GAP, ...params }),
  "good-ddr": (params?: Partial<DdrParams>) => ddrSerpentine({ gap: DDR_GOOD_GAP, ...params }),
  "wifi-ifa": wifiIfa,
  "hairpin-bpf": hairpinBpf,
  "wilkinson-divider": wilkinsonDivider,
}

/** Renders one example to Circuit JSON; `params` overrides the tuned defaults of the parametrised ones. */
export const renderExample = async (name: string, params?: Record<string, number>): Promise<any[]> => {
  const build = examples[name]
  if (!build) throw new Error(`unknown example ${name}`)
  const circuit = new Circuit()
  circuit.add(build(params))
  await circuit.renderUntilSettled()
  return circuit.getCircuitJson() as any[]
}

if (import.meta.main) {
  const only = process.argv[2]
  for (const name of Object.keys(examples)) {
    if (only && only !== name) continue
    const json = await renderExample(name)
    const out = join(import.meta.dir, `${name}.circuit.json`)
    writeFileSync(out, JSON.stringify(json, null, 1))
    const counts: Record<string, number> = {}
    for (const el of json) counts[el.type] = (counts[el.type] ?? 0) + 1
    console.log(name, JSON.stringify(counts))
  }
}
