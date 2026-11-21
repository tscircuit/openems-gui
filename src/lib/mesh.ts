/**
 * Rectilinear FDTD mesh generation.
 *
 * openEMS needs one sorted list of mesh lines per axis. We start from "fixed"
 * lines (substrate edges, copper edges, port and via positions), merge the
 * ones that are closer than the minimum cell size, then fill the gaps so that
 * no cell is larger than the local limit and neighbouring cells never differ
 * by more than `ratio`.
 */

export interface LineSpec {
  pos: number
  /** 3 = must be kept exactly (ports, box edges), 2 = via centre, 1 = copper edge */
  priority: number
}

/** Collapses clusters of lines closer than `minSpacing`, keeping the highest priority one. */
export const mergeLines = (specs: LineSpec[], minSpacing: number): number[] => {
  const sorted = [...specs].sort((a, b) => a.pos - b.pos)
  const out: LineSpec[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.pos - last.pos < minSpacing) {
      if (s.priority >= 3 && last.priority >= 3) {
        // both are hard constraints (port ends, box edges): keep both unless coincident
        if (s.pos - last.pos > 1e-6) out.push(s)
        else if (s.priority > last.priority) out[out.length - 1] = s
      } else if (s.priority > last.priority) out[out.length - 1] = s
      // otherwise keep the earlier line; averaging would walk lines off real edges
      continue
    }
    out.push(s)
  }
  return out.map((s) => s.pos)
}

const fillGap = (len: number, leftCell: number, rightCell: number, max: number, ratio: number): number[] => {
  const left: number[] = []
  const right: number[] = []
  let nl = Math.min(max, leftCell * ratio)
  let nr = Math.min(max, rightCell * ratio)
  let sum = 0
  let guard = 0
  while (sum < len - 1e-12 && guard++ < 100000) {
    if (nl <= nr) {
      left.push(nl)
      sum += nl
      nl = Math.min(max, nl * ratio)
    } else {
      right.push(nr)
      sum += nr
      nr = Math.min(max, nr * ratio)
    }
  }
  const sizes = [...left, ...right.reverse()]
  const scale = len / sum
  return sizes.map((s) => s * scale)
}

/**
 * Inserts lines between the fixed ones. `maxCell(x)` is the largest allowed
 * cell at position x; it should be constant between two fixed lines.
 */
export const fillMesh = (fixed: number[], maxCell: (x: number) => number, ratio = 1.4): number[] => {
  const lines = [...fixed].sort((a, b) => a - b)
  if (lines.length < 2) return lines
  const out: number[] = [lines[0]]
  let prevCell = Infinity
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    const len = b - a
    const max = maxCell((a + b) / 2)
    if (len <= max * 1.02) {
      out.push(b)
      prevCell = len
      continue
    }
    let rightCell = Infinity
    if (i + 2 < lines.length) {
      const nextLen = lines[i + 2] - b
      if (nextLen <= maxCell((b + lines[i + 2]) / 2) * 1.02) rightCell = nextLen
    }
    const sizes = fillGap(len, prevCell, rightCell, max, ratio)
    let x = a
    for (let k = 0; k < sizes.length - 1; k++) {
      x += sizes[k]
      out.push(x)
    }
    out.push(b)
    prevCell = sizes[sizes.length - 1]
  }
  return out
}

export const minCell = (lines: number[]): number => {
  let m = Infinity
  for (let i = 0; i + 1 < lines.length; i++) m = Math.min(m, lines[i + 1] - lines[i])
  return m
}
