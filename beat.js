'use strict';
// ===============================================================
// beat.js — 音楽データからビートを見つけて、譜面のもとを作る
//   1. 音の「立ち上がり」の強さを、低音〜高音の4つの帯域ごとに調べる
//   2. くし形フィルタでテンポ(BPM)と拍の位置をさがす
//   3. 立ち上がりを拍の格子に合わせて、ノーツの候補にする
//   低い音は左のレーン、高い音は右のレーンに割り当てる
// ===============================================================

(function (global) {
  const TAU = Math.PI * 2;
  const FFT_N = 1024;
  const HOP = 512;
  const BAND_EDGES = [0, 180, 700, 2600, 24000];   // Hz。レーン0〜3に対応

  // ---- FFT (2のべき乗・その場計算) ----
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  const rev = new Uint16Array(FFT_N);
  const cosT = new Float32Array(FFT_N / 2);
  const sinT = new Float32Array(FFT_N / 2);
  const hann = new Float32Array(FFT_N);

  (function initTables() {
    const bits = Math.round(Math.log2(FFT_N));
    for (let i = 0; i < FFT_N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
      hann[i] = 0.5 - 0.5 * Math.cos(TAU * i / (FFT_N - 1));
    }
    for (let i = 0; i < FFT_N / 2; i++) {
      cosT[i] = Math.cos(-TAU * i / FFT_N);
      sinT[i] = Math.sin(-TAU * i / FFT_N);
    }
  })();

  function fft() {
    for (let i = 0; i < FFT_N; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= FFT_N; size <<= 1) {
      const half = size >> 1, step = FFT_N / size;
      for (let i = 0; i < FFT_N; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step, c = cosT[k], s = sinT[k];
          const a = i + j, b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // ---- 帯域ごとの立ち上がり (スペクトルフラックス) ----
  function onsetBands(buf) {
    const n = buf.length, ch = buf.numberOfChannels;
    const x = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) x[i] += d[i] / ch;
    }
    const frames = Math.max(1, Math.floor((n - FFT_N) / HOP) + 1);
    const nb = BAND_EDGES.length - 1;
    const bands = [];
    for (let b = 0; b < nb; b++) bands.push(new Float32Array(frames));

    const binHz = buf.sampleRate / FFT_N;
    const binBand = new Int8Array(FFT_N / 2);
    for (let k = 0; k < FFT_N / 2; k++) {
      const f = k * binHz;
      let b = nb - 1;
      for (let j = 0; j < nb; j++) if (f >= BAND_EDGES[j] && f < BAND_EDGES[j + 1]) { b = j; break; }
      binBand[k] = b;
    }

    // 高音の帯域ほど FFT の区間が多いので、区間の数で割ってならす
    const binCount = new Float32Array(nb);
    for (let k = 1; k < FFT_N / 2; k++) binCount[binBand[k]]++;
    for (let b = 0; b < nb; b++) binCount[b] = Math.max(1, binCount[b]);

    const prev = new Float32Array(FFT_N / 2);
    for (let t = 0; t < frames; t++) {
      const off = t * HOP;
      for (let i = 0; i < FFT_N; i++) { re[i] = x[off + i] * hann[i]; im[i] = 0; }
      fft();
      for (let k = 1; k < FFT_N / 2; k++) {
        // 音の大きさは対数で見る (小さい音の変化も拾えるように)
        const m = Math.log1p(200 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        const d = m - prev[k];
        if (d > 0) bands[binBand[k]][t] += d / binCount[binBand[k]];
        prev[k] = m;
      }
    }
    return { bands, fps: buf.sampleRate / HOP, frames };
  }

  // 移動平均を引いて、鳴り続けている音より「立ち上がり」を目立たせる
  function sharpen(env, fps, winSec) {
    const w = Math.max(1, Math.round(winSec * fps));
    const pre = new Float64Array(env.length + 1);
    for (let i = 0; i < env.length; i++) pre[i + 1] = pre[i] + env[i];
    const out = new Float32Array(env.length);
    for (let i = 0; i < env.length; i++) {
      const a = Math.max(0, i - w), b = Math.min(env.length, i + w + 1);
      out[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
    }
    return out;
  }

  const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));

  const envAt = (env, t) => {
    if (t < 0 || t >= env.length - 1) return 0;
    const i = t | 0, f = t - i;
    return env[i] * (1 - f) + env[i + 1] * f;
  };

  // そのテンポ・位置に拍を置いたとき、どれだけ音の立ち上がりと重なるか
  function combScore(env, period, phase) {
    let s = 0, n = 0;
    for (let t = phase; t < env.length - 1; t += period) { s += envAt(env, t); n++; }
    return n ? s / n : 0;
  }

  function bestPhase(env, period) {
    let bp = 0, bs = -1;
    for (let ph = 0; ph < period; ph += 0.25) {
      const s = combScore(env, period, ph);
      if (s > bs) { bs = s; bp = ph; }
    }
    return { phase: bp, score: bs };
  }

  // 立ち上がりを少しぼかす。テンポがわずかにずれても点が入るようにするため
  function smoothGauss(env, sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) * (i / sigma)); k[i + r] = v; sum += v; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const out = new Float32Array(env.length);
    for (let t = 0; t < env.length; t++) {
      const a = Math.max(0, t - r), b = Math.min(env.length - 1, t + r);
      let s = 0;
      for (let u = a; u <= b; u++) s += env[u] * k[u - t + r];
      out[t] = s;
    }
    return out;
  }

  // ---- テンポ推定 ----
  // よくあるテンポ(120前後)を少し優先して、倍速・半速の取り違えを減らす
  const tempoPrior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));

  function estimateTempo(env, fps, minBpm, maxBpm) {
    const len = env.length;
    const soft = smoothGauss(env, 0.035 * fps);   // 前後35ms ぶんの許容
    const minLag = Math.max(2, Math.floor(60 / maxBpm * fps));
    const maxLag = Math.min(len - 2, Math.ceil(60 / minBpm * fps));

    // 自己相関: 同じ間隔で音が並んでいるほど高くなる
    const acf = new Float64Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let t = 0; t + lag < len; t++) s += env[t] * env[t + lag];
      acf[lag] = s / (len - lag);
    }

    // 山の頂点を放物線で補間して、フレーム単位より細かいテンポを得る
    const cands = [];
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (acf[lag] < acf[lag - 1] || acf[lag] < acf[lag + 1]) continue;
      const d = acf[lag - 1] - 2 * acf[lag] + acf[lag + 1];
      const adj = d < 0 ? clampNum(0.5 * (acf[lag - 1] - acf[lag + 1]) / d, -0.5, 0.5) : 0;
      const bpm = 60 / ((lag + adj) / fps);
      cands.push({ bpm, score: acf[lag] * tempoPrior(bpm) });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);

    // 上位の候補と、その半分・2倍・3倍もまとめて試す
    const tries = [];
    for (const c of cands.slice(0, 8)) {
      for (const mul of [0.5, 1, 2, 3]) {
        const bpm = c.bpm * mul;
        if (bpm < minBpm || bpm > maxBpm) continue;
        if (tries.some((v) => Math.abs(v / bpm - 1) < 0.004)) continue;
        tries.push(bpm);
      }
    }

    const scoreAt = (bpm, phase) => {
      const period = 60 / bpm * fps;
      let s = 0, n = 0;
      for (let t = phase; t < len - 1; t += period) { s += envAt(soft, t); n++; }
      return n ? s / n : 0;
    };
    const searchPhase = (bpm, step, from, to) => {
      const period = 60 / bpm * fps;
      let bp = 0, bs = -1;
      const a = from === undefined ? 0 : from, b = to === undefined ? period : to;
      for (let ph = a; ph < b; ph += step) {
        const s = scoreAt(bpm, ((ph % period) + period) % period);
        if (s > bs) { bs = s; bp = ph; }
      }
      return { phase: ((bp % period) + period) % period, score: bs };
    };

    // 1段目: 候補ごとに ±1.5% をざっと見る
    let best = null;
    for (const bpm0 of tries) {
      const span = bpm0 * 0.015;
      for (let bpm = bpm0 - span; bpm <= bpm0 + span; bpm += bpm0 * 0.0015) {
        if (bpm < minBpm || bpm > maxBpm) continue;
        const period = 60 / bpm * fps;
        const r = searchPhase(bpm, period / 48);
        const total = r.score * tempoPrior(bpm);
        if (!best || total > best.total) best = { bpm, phase: r.phase, score: r.score, total };
      }
    }
    if (!best) return null;

    // 2段目: 勝った候補の周りをさらに細かく詰める
    for (let k = 0; k < 2; k++) {
      const span = best.bpm * (k === 0 ? 0.002 : 0.0004);
      const step = best.bpm * (k === 0 ? 0.0002 : 0.00004);
      const period0 = 60 / best.bpm * fps;
      for (let bpm = best.bpm - span; bpm <= best.bpm + span; bpm += step) {
        const period = 60 / bpm * fps;
        const r = searchPhase(bpm, period / 200, best.phase - period0 / 24, best.phase + period0 / 24);
        const total = r.score * tempoPrior(bpm);
        if (total > best.total) best = { bpm, phase: r.phase, score: r.score, total };
      }
    }

    let mean = 0;
    for (let i = 0; i < len; i++) mean += soft[i];
    mean /= len;
    best.confidence = mean > 0 ? best.score / mean : 0;
    best.soft = soft;
    return best;
  }

  // ---- 拍の格子を引き直す ----
  // 強い立ち上がりを8分音符の格子に対応づけ、最小二乗法でテンポと位置を微調整する。
  // 30秒のあいだに少しずつずれていくのを防ぐため。
  function refineGrid(soft, fps, bpm, offset, duration) {
    const peaks = [];
    for (let i = 2; i < soft.length - 2; i++) {
      const v = soft[i];
      if (v > soft[i - 1] && v >= soft[i + 1] && v > soft[i - 2] && v >= soft[i + 2]) peaks.push({ t: i / fps, v });
    }
    if (peaks.length < 8) return { bpm, offset };
    peaks.sort((a, b) => b.v - a.v);
    const use = peaks.slice(0, Math.min(120, peaks.length));

    let B = 30 / bpm, A = offset;   // B = 8分音符1つぶんの秒数
    for (let iter = 0; iter < 3; iter++) {
      let Sw = 0, Swk = 0, Swk2 = 0, Swt = 0, Swkt = 0, n = 0;
      for (const p of use) {
        const k = Math.round((p.t - A) / B);
        if (Math.abs(p.t - (A + k * B)) > B * 0.3) continue;
        const w = p.v;
        Sw += w; Swk += w * k; Swk2 += w * k * k; Swt += w * p.t; Swkt += w * k * p.t; n++;
      }
      if (n < 8) break;
      const den = Sw * Swk2 - Swk * Swk;
      if (Math.abs(den) < 1e-9) break;
      const nb = (Sw * Swkt - Swk * Swt) / den;
      const na = (Swt - nb * Swk) / Sw;
      if (!isFinite(nb) || !isFinite(na) || Math.abs(nb / (30 / bpm) - 1) > 0.03) break;
      B = nb; A = na;
    }
    const outBpm = 30 / B;
    if (!isFinite(outBpm) || outBpm < 40 || outBpm > 250) return { bpm, offset };
    // 1拍目が曲の頭より前にならないように戻す
    let off = A;
    const beat = 60 / outBpm;
    while (off < 0) off += beat;
    while (off > beat) off -= beat;
    return { bpm: outBpm, offset: off };
  }

  // ---- 解析結果からノーツを作る ----
  // 1秒あたりのノーツ数のめやすと、連打になりすぎない最小の間隔
  const DENSITY = {
    easy:   { div: 1, perSec: 1.1, gap: 0.34 },
    normal: { div: 2, perSec: 2.1, gap: 0.19 },
    hard:   { div: 4, perSec: 3.4, gap: 0.10 },
  };

  function buildNotes(a, diff, fromSec, toSec) {
    const d = DENSITY[diff] || DENSITY.normal;
    const beat = 60 / a.bpm;
    const slot = beat / d.div;
    const from = fromSec === undefined ? 0 : fromSec;
    const to = Math.min(toSec === undefined ? a.duration : toSec, a.duration);
    const tol = Math.min(0.055, slot * 0.45);
    const nb = a.bands.length;

    // 格子の一つひとつについて、その近くで音がどれだけ立ち上がったかを調べる
    const slots = [];
    const k0 = Math.ceil((from - a.offset) / slot);
    const k1 = Math.floor((to - a.offset) / slot);
    for (let k = k0; k <= k1; k++) {
      const t = a.offset + k * slot;
      const f0 = Math.max(0, Math.round((t - tol) * a.fps));
      const f1 = Math.min(a.env.length - 1, Math.round((t + tol) * a.fps));
      let v = 0, at = f0;
      for (let f = f0; f <= f1; f++) if (a.soft[f] > v) { v = a.soft[f]; at = f; }
      let lane = 0, bv = -1;
      for (let b = 0; b < nb; b++) {
        let s = 0;
        for (let f = Math.max(0, at - 1); f <= Math.min(a.bands[b].length - 1, at + 1); f++) s += a.bands[b][f];
        if (s > bv) { bv = s; lane = b; }
      }
      // 拍の頭は少し優遇する (曲の骨格が譜面に出るように)
      const onBeat = ((k % d.div) + d.div) % d.div === 0;
      slots.push({ t, v: v * (onBeat ? 1.35 : 1), raw: v, lane, onBeat });
    }
    if (!slots.length) return [];

    // ねらった密度になるように、強いほうから採る
    const want = clampNum(Math.round((to - from) * d.perSec), 1, slots.length);
    const sorted = slots.slice().sort((x, y) => y.v - x.v);
    const thr = sorted[want - 1].v;

    const notes = [];
    let last = -99, lastLane = -1, run = 0;
    for (const s of slots) {
      if (s.v < thr || s.raw <= 0) continue;
      if (s.t - last < d.gap) continue;
      let lane = s.lane;
      // 同じレーンが続きすぎたら、となりにずらす
      if (lane === lastLane) { run++; if (run >= 2) { lane = (lane + (run % 2 ? 1 : nb - 1)) % nb; run = 0; } }
      else run = 0;
      notes.push({ time: s.t, lane, strength: s.raw, onBeat: s.onBeat });
      last = s.t; lastLane = lane;
    }
    return notes;
  }

  // いちばん盛り上がっている4小節をさがす (サビ=フィーバーに使う)
  function feverRange(a) {
    const bar = 60 / a.bpm * 4;
    const win = bar * 4;
    if (a.duration < win * 2) return null;
    let best = null;
    for (let t = a.offset; t + win <= a.duration; t += bar) {
      const f0 = Math.max(0, Math.round(t * a.fps));
      const f1 = Math.min(a.env.length, Math.round((t + win) * a.fps));
      let s = 0;
      for (let f = f0; f < f1; f++) s += a.env[f];
      if (!best || s > best.s) best = { s, t };
    }
    return best ? [best.t, best.t + win] : null;
  }

  // ---- 解析本体 ----
  function analyze(buf, opts) {
    const o = opts || {};
    const t0 = (global.performance || Date).now();
    const { bands, fps } = onsetBands(buf);
    const sharp = bands.map((b) => sharpen(b, fps, 0.35));
    const total = new Float32Array(sharp[0].length);
    for (const b of sharp) for (let i = 0; i < b.length; i++) total[i] += b[i];

    const t = estimateTempo(total, fps, o.minBpm || 60, o.maxBpm || 200);
    if (!t) return null;
    // FFT の窓の分だけ検出が早まるので、窓の中央を基準に直す
    const lead0 = FFT_N / 2 / buf.sampleRate;
    const g = refineGrid(t.soft, fps, t.bpm, t.phase / fps + lead0, buf.duration);
    return {
      bpm: Math.round(g.bpm * 100) / 100,
      offset: g.offset,                 // 1拍目の時刻 (秒)
      confidence: Math.round(t.confidence * 100) / 100,
      fps, bands: sharp, env: total, soft: t.soft,
      duration: buf.duration,
      ms: Math.round((global.performance || Date).now() - t0),
    };
  }

  global.Beat = { analyze, buildNotes, feverRange, refineGrid, onsetBands, estimateTempo, sharpen, smoothGauss, envAt };
})(window);
