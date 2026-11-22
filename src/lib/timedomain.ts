/**
 * Time-domain views of S-parameters: step response (TDT), impedance profile (TDR), delay and skew.
 *
 * The S-parameters are band limited, so they are multiplied by a Gaussian low-pass that corresponds to a
 * step with a given 10–90 % rise time before the inverse transform. A rise time shorter than about
 * 1 / f_max leaves truncation ripple (Gibbs) on the curves.
 */

export interface Spectrum {
  /** Hz, ascending */
  freq: number[]
  re: number[]
  im: number[]
}

export interface StepResponse {
  /** ps; t = 0 is the 50 % point of the incident step */
  t: number[]
  v: number[]
  /** value the response settles to (the DC gain) */
  final: number
  riseTimePs: number
}

/** In-place radix-2 FFT (inverse when `inverse` is set, without the 1/N factor). */
export const fft = (re: Float64Array, im: Float64Array, inverse = false): void => {
  const n = re.length
  if (n & (n - 1)) throw new Error("fft length must be a power of two")
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** Shortest rise time (ps) the band supports without visible truncation ripple. */
export const minRiseTimePs = (fMaxHz: number): number => (1.1 / fMaxHz) * 1e12

/** Resamples a spectrum onto the harmonic grid k·df (k = 0…K), extrapolating to DC. */
const harmonicGrid = (s: Spectrum): { df: number; re: Float64Array; im: Float64Array } => {
  const n = s.freq.length
  if (n < 3) throw new Error("need at least three frequency points")
  const fMax = s.freq[n - 1]
  // spacing of the simulated grid (ignore a first point that sits at ~DC)
  const df = (fMax - s.freq[1]) / (n - 2)
  const K = Math.floor(fMax / df + 1e-6)
  const re = new Float64Array(K + 1)
  const im = new Float64Array(K + 1)
  // Below the first usable sample the response is extended in magnitude and phase. A quasi-DC
  // sample is skipped (numerically the least reliable one). The DC value has to be real, so the
  // phase is pinned to the nearest multiple of pi there.
  const a = s.freq[0] < df * 0.1 ? 1 : 0
  const f0 = s.freq[a]
  const f1 = s.freq[a + 1]
  const m0 = Math.hypot(s.re[a], s.im[a])
  const m1 = Math.hypot(s.re[a + 1], s.im[a + 1])
  const p0 = Math.atan2(s.im[a], s.re[a])
  let p1 = Math.atan2(s.im[a + 1], s.re[a + 1])
  while (p1 - p0 > Math.PI) p1 -= 2 * Math.PI
  while (p1 - p0 < -Math.PI) p1 += 2 * Math.PI
  const slope = (p1 - p0) / (f1 - f0)
  const pDc = Math.round((p0 - slope * f0) / Math.PI) * Math.PI
  let j = 0
  for (let k = 0; k <= K; k++) {
    const f = k * df
    if (f < f0) {
      const mag = Math.max(0, m0 + ((m1 - m0) * (f - f0)) / (f1 - f0))
      const ph = pDc + ((p0 - pDc) * f) / f0
      re[k] = mag * Math.cos(ph)
      im[k] = k === 0 ? 0 : mag * Math.sin(ph)
      continue
    }
    while (j + 2 < n && s.freq[j + 1] < f) j++
    const w = Math.min(1, Math.max(0, (f - s.freq[j]) / (s.freq[j + 1] - s.freq[j])))
    re[k] = s.re[j] + (s.re[j + 1] - s.re[j]) * w
    im[k] = s.im[j] + (s.im[j + 1] - s.im[j]) * w
  }
  return { df, re, im }
}

/**
 * Response to a unit step with the given 10–90 % rise time (Gaussian edge).
 * `tMaxPs` limits the returned window; `preTimePs` is how far before t = 0 it starts.
 */
export const stepResponse = (s: Spectrum, opts: { riseTimePs?: number; tMaxPs?: number } = {}): StepResponse => {
  const { df, re: hr, im: hi } = harmonicGrid(s)
  const K = hr.length - 1
  const fMax = K * df
  const riseTimePs = opts.riseTimePs && opts.riseTimePs > 0 ? opts.riseTimePs : minRiseTimePs(fMax)
  // Gaussian step: 10–90 % rise time = 2.563 sigma
  const sigma = (riseTimePs * 1e-12) / 2.563
  let N = 1024
  while (N < 32 * (K + 1)) N <<= 1
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let k = 0; k <= K; k++) {
    const f = k * df
    const g = Math.exp(-2 * Math.PI * Math.PI * sigma * sigma * f * f)
    re[k] = hr[k] * g
    im[k] = hi[k] * g
    if (k > 0) {
      re[N - k] = re[k]
      im[N - k] = -im[k]
    }
  }
  fft(re, im, true)
  // h[n]·dt = re[n] / N ; the periodic impulse response sums to the DC gain
  const dt = 1 / (N * df)
  const period = N * dt
  const pre = Math.min(N >> 2, Math.max(8, Math.ceil((4 * sigma) / dt)))
  const tMax = Math.min(opts.tMaxPs ? opts.tMaxPs * 1e-12 : period / 2, period - 2 * pre * dt)
  const count = Math.max(2, Math.min(N - pre, Math.floor(tMax / dt)))
  const t: number[] = []
  const v: number[] = []
  let acc = 0
  for (let i = -pre; i < count; i++) {
    acc += re[(i + N) % N] / N
    t.push((i + 0.5) * dt * 1e12)
    v.push(acc)
  }
  return { t, v, final: hr[0], riseTimePs }
}

/** First time (ps) at which the curve crosses `level`, linearly interpolated; null if it never does. */
export const crossingTime = (t: number[], v: number[], level: number): number | null => {
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1]
    const b = v[i]
    if ((a < level && b >= level) || (a > level && b <= level)) return t[i - 1] + ((level - a) / (b - a)) * (t[i] - t[i - 1])
  }
  return null
}

/** Propagation delay (ps): when the transmitted step reaches half of its final value. */
export const stepDelayPs = (r: StepResponse): number | null => (Math.abs(r.final) < 1e-3 ? null : crossingTime(r.t, r.v, r.final / 2))

/** 10–90 % rise time (ps) of a step response. */
export const riseTime1090Ps = (r: StepResponse): number | null => {
  const a = crossingTime(r.t, r.v, 0.1 * r.final)
  const b = crossingTime(r.t, r.v, 0.9 * r.final)
  return a === null || b === null ? null : b - a
}

/** TDR impedance profile (Ω) seen from a port: Z(t) = Z0 (1 + ρ) / (1 − ρ), t is the round-trip time. */
export const tdrImpedance = (s11: Spectrum, z0: number, opts: { riseTimePs?: number; tMaxPs?: number } = {}): { t: number[]; z: number[]; riseTimePs: number } => {
  const r = stepResponse(s11, opts)
  return { t: r.t, z: r.v.map((rho) => (z0 * (1 + rho)) / Math.max(1e-6, 1 - rho)), riseTimePs: r.riseTimePs }
}

/** Unwrapped phase (rad). */
export const unwrapPhase = (re: number[], im: number[]): number[] => {
  const out: number[] = []
  let offset = 0
  let prev = 0
  for (let k = 0; k < re.length; k++) {
    const p = Math.atan2(im[k], re[k])
    if (k > 0) {
      const d = p - prev
      if (d > Math.PI) offset -= 2 * Math.PI
      else if (d < -Math.PI) offset += 2 * Math.PI
    }
    prev = p
    out.push(p + offset)
  }
  return out
}

/** Group delay −dφ/dω in ps, same length as the input (central differences). */
export const groupDelayPs = (s: Spectrum): number[] => {
  const ph = unwrapPhase(s.re, s.im)
  const n = ph.length
  return ph.map((_, k) => {
    const a = Math.max(0, k - 1)
    const b = Math.min(n - 1, k + 1)
    return (-(ph[b] - ph[a]) / (2 * Math.PI * (s.freq[b] - s.freq[a]))) * 1e12
  })
}

/**
 * Phase delay −φ/ω in ps. The phase is unwrapped from the lowest frequency, where a through path is
 * assumed to be less than half a period long.
 */
export const phaseDelayPs = (s: Spectrum): number[] => {
  const ph = unwrapPhase(s.re, s.im)
  return ph.map((p, k) => (s.freq[k] > 0 ? (-p / (2 * Math.PI * s.freq[k])) * 1e12 : Number.NaN))
}
