'use strict';
// ===============================================================
// 顔ノーツ☆カラオケバトル
//   仲間の顔写真がノーツになって流れてくるリズムゲーム。
//   スマホ1台を回して順番にプレイし、最後に顔写真つきで結果発表する。
//   写真は localStorage (この端末の中) にだけ保存し、外部には送信しない。
// ===============================================================

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const perfNow = () => performance.now() / 1000;

const LANES = 4;
const WINDOW = { perfect: 0.055, great: 0.105, good: 0.16 };   // 判定幅 (秒)
const WEIGHT = { perfect: 1, great: 0.75, good: 0.4, miss: 0 };
const APPROACH = { easy: 1.7, normal: 1.45, hard: 1.2 };        // ノーツが見えてから判定ラインまでの秒数
const JUDGE_LABEL = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
const JUDGE_COLOR = { perfect: '#ffd84d', great: '#7dffb0', good: '#3fe0ff', miss: '#9d94bd' };
const LANE_COLOR = ['#ff4fa3', '#3fe0ff', '#ffd84d', '#7dffb0'];
const AVATAR_COLORS = ['#ff4fa3', '#3fe0ff', '#ffb02e', '#4fd67a', '#ff8a3d', '#b18cff', '#5b9dff', '#ff6b6b'];
const DIFF_LABEL = { easy: 'かんたん', normal: 'ふつう', hard: 'むずかしい' };
const KEY_LANE = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

// 再現性のある乱数 (同じ曲はいつも同じ譜面になる)
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------
// 保存データ (メンバーと設定)
// ---------------------------------------------------------------
const STORE_KEY = 'krg.v1';
const state = {
  players: [],   // { id, name, photo (dataURL | null), color, active }
  settings: { mode: 'builtin', song: 0, diff: 'normal', length: 90, sfx: true, shuffle: false, offset: 0, roundBpm: true },
};

function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.players)) state.players = d.players;
    if (d && d.settings) Object.assign(state.settings, d.settings);
  } catch (e) { /* 壊れていたら初期状態で始める */ }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;   // 容量オーバーなど。保存できなくてもこの回は遊べる
  }
}

const activePlayers = () => state.players.filter((p) => p.active !== false);
const playerById = (id) => state.players.find((p) => p.id === id);

// ---------------------------------------------------------------
// 顔スプライト (丸く切り抜いた画像をあらかじめ作っておく)
// ---------------------------------------------------------------
const SPRITE = 192;
const sprites = new Map();   // id -> { color: canvas, gray: canvas }

function buildSprite(p) {
  return new Promise((resolve) => {
    const finish = (img) => {
      const c = document.createElement('canvas');
      c.width = c.height = SPRITE;
      const x = c.getContext('2d');
      x.save();
      x.beginPath(); x.arc(SPRITE / 2, SPRITE / 2, SPRITE / 2, 0, TAU); x.clip();
      if (img) {
        x.drawImage(img, 0, 0, SPRITE, SPRITE);
      } else {
        // 写真がない人は、色つきの丸に名前の1文字目
        x.fillStyle = p.color || AVATAR_COLORS[0];
        x.fillRect(0, 0, SPRITE, SPRITE);
        x.fillStyle = 'rgba(255,255,255,0.95)';
        x.font = `bold ${SPRITE * 0.5}px "Hiragino Maru Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif`;
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(Array.from(p.name || '？')[0], SPRITE / 2, SPRITE / 2 + SPRITE * 0.03);
      }
      x.restore();

      // ミスしたとき用の灰色バージョン
      const g = document.createElement('canvas');
      g.width = g.height = SPRITE;
      const gx = g.getContext('2d');
      gx.drawImage(c, 0, 0);
      try {
        const im = gx.getImageData(0, 0, SPRITE, SPRITE);
        const d = im.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) * 0.6;
          d[i] = v; d[i + 1] = v; d[i + 2] = v * 1.25;
        }
        gx.putImageData(im, 0, 0);
      } catch (e) { /* 失敗したらカラーのまま使う */ }

      sprites.set(p.id, { color: c, gray: g });
      resolve();
    };
    if (p.photo) {
      const img = new Image();
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = p.photo;
    } else {
      finish(null);
    }
  });
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// 切り抜き画面の点線 (高さ42%) に目を合わせてもらう前提で、目の位置を決め打ちする
function drawSunglasses(c, cx, cy, r) {
  const y = cy - r * 0.16, w = r * 0.5, h = r * 0.32, gap = r * 0.1;
  c.save();
  c.fillStyle = '#0d0d12';
  c.strokeStyle = '#0d0d12';
  c.lineWidth = r * 0.07;
  c.lineCap = 'round';
  roundRectPath(c, cx - gap / 2 - w, y - h / 2, w, h, h * 0.4); c.fill();
  roundRectPath(c, cx + gap / 2, y - h / 2, w, h, h * 0.4); c.fill();
  c.beginPath();
  c.moveTo(cx - gap / 2 - 1, y - h * 0.2); c.lineTo(cx + gap / 2 + 1, y - h * 0.2);
  c.moveTo(cx - gap / 2 - w, y - h * 0.2); c.lineTo(cx - r * 0.97, y - h * 0.45);
  c.moveTo(cx + gap / 2 + w, y - h * 0.2); c.lineTo(cx + r * 0.97, y - h * 0.45);
  c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.4)';
  for (const sx of [cx - gap / 2 - w * 0.8, cx + gap / 2 + w * 0.2]) {
    c.beginPath();
    c.moveTo(sx, y - h * 0.3); c.lineTo(sx + w * 0.3, y - h * 0.3);
    c.lineTo(sx + w * 0.12, y + h * 0.2); c.lineTo(sx - w * 0.05, y + h * 0.2);
    c.closePath(); c.fill();
  }
  c.restore();
}

function drawCrown(c, cx, cy, r) {
  const w = r * 1.15, h = r * 0.62;
  c.save();
  c.translate(cx, cy - r * 0.8);
  c.rotate(-0.1);
  const grad = c.createLinearGradient(0, -h, 0, 0);
  grad.addColorStop(0, '#fff3a6'); grad.addColorStop(1, '#f0a800');
  c.fillStyle = grad;
  c.strokeStyle = '#9a6200';
  c.lineWidth = Math.max(1.5, r * 0.05);
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(-w / 2, 0);
  c.lineTo(-w * 0.56, -h * 0.85);
  c.lineTo(-w * 0.23, -h * 0.42);
  c.lineTo(0, -h);
  c.lineTo(w * 0.23, -h * 0.42);
  c.lineTo(w * 0.56, -h * 0.85);
  c.lineTo(w / 2, 0);
  c.closePath();
  c.fill(); c.stroke();
  const jewels = [[-w * 0.56, -h * 0.85, '#ff4f6d'], [0, -h, '#4fc3ff'], [w * 0.56, -h * 0.85, '#ff4f6d']];
  for (const [jx, jy, col] of jewels) {
    c.fillStyle = col;
    c.beginPath(); c.arc(jx, jy, r * 0.085, 0, TAU); c.fill(); c.stroke();
  }
  c.restore();
}

function drawTears(c, cx, cy, r, time) {
  const top = cy - r * 0.02, bottom = cy + r * 0.8;
  c.save();
  for (const side of [-1, 1]) {
    const x = cx + side * r * 0.3;
    c.strokeStyle = 'rgba(120,190,255,0.75)';
    c.lineWidth = r * 0.13;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(x, top); c.lineTo(x + side * r * 0.04, bottom); c.stroke();
    const k = (time * 1.3 + (side > 0 ? 0.5 : 0)) % 1;
    const y = top + (bottom - top) * k;
    c.fillStyle = '#dff1ff';
    c.beginPath(); c.arc(x + side * r * 0.04 * k, y, r * 0.09, 0, TAU); c.fill();
  }
  c.restore();
}

function drawSparkles(c, cx, cy, r, time) {
  const pts = [[-1.08, -0.55], [1.12, -0.3], [0.98, 0.72], [-1.02, 0.62]];
  c.save();
  c.fillStyle = '#fff6b8';
  pts.forEach(([px, py], i) => {
    const s = r * 0.2 * (0.55 + 0.45 * Math.sin(time * 6 + i * 1.7));
    const x = cx + px * r, y = cy + py * r;
    c.beginPath();
    c.moveTo(x, y - s); c.quadraticCurveTo(x, y, x + s, y);
    c.quadraticCurveTo(x, y, x, y + s); c.quadraticCurveTo(x, y, x - s, y);
    c.quadraticCurveTo(x, y, x, y - s);
    c.fill();
  });
  c.restore();
}

// deco: { glasses, crown, sparkle, rainbow, tears }
function drawAvatar(c, id, cx, cy, r, deco, time) {
  const sp = sprites.get(id);
  deco = deco || {};
  if (deco.rainbow) {
    c.save();
    c.lineWidth = r * 0.16;
    for (let i = 0; i < 12; i++) {
      c.strokeStyle = `hsl(${(i * 30 + time * 240) % 360}, 100%, 62%)`;
      c.beginPath(); c.arc(cx, cy, r * 1.12, (i / 12) * TAU, ((i + 1) / 12) * TAU + 0.02); c.stroke();
    }
    c.restore();
  }
  if (sp) c.drawImage(deco.tears ? sp.gray : sp.color, cx - r, cy - r, r * 2, r * 2);
  c.save();
  c.strokeStyle = '#fff';
  c.lineWidth = Math.max(2, r * 0.07);
  c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke();
  c.restore();
  if (deco.tears) drawTears(c, cx, cy, r, time);
  if (deco.glasses) drawSunglasses(c, cx, cy, r);
  if (deco.crown) drawCrown(c, cx, cy, r);
  if (deco.sparkle) drawSparkles(c, cx, cy, r, time);
}

// メニュー画面に置くアバター (王冠がはみ出すぶん、上と左右に余白を取る)
function avatarCanvas(id, size, deco) {
  const w = Math.round(size * 1.5), h = Math.round(size * 1.55);
  const c = document.createElement('canvas');
  c.width = w * 2; c.height = h * 2;
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const x = c.getContext('2d');
  x.scale(2, 2);
  drawAvatar(x, id, w / 2, h - size / 2 - size * 0.12, size / 2, deco, 0.3);
  return c;
}

function setAvatar(el, id, size, deco) {
  el.textContent = '';
  el.appendChild(avatarCanvas(id, size, deco));
}

// ---------------------------------------------------------------
// サウンド (WebAudio の合成音だけで作る。音源ファイルは使わない)
// ---------------------------------------------------------------
let actx = null;
let master = null;
let noiseBuf = null;
let audioUnlocked = false;
let holdSuspend = false;   // ポーズ中は勝手に再開させない

// タップ操作のたびに呼ぶ。iOS Safari はユーザー操作中でないと音声を開始できない
function initAudio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // iPhone の消音スイッチがオンでも鳴るように「メディア再生」扱いにする (iOS 16.4+)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* 非対応でも問題なし */ }
    actx = new AC();
    const comp = actx.createDynamicsCompressor();
    comp.connect(actx.destination);
    master = actx.createGain();
    master.gain.value = 0.85;
    master.connect(comp);
    noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (holdSuspend) return;
  // iOS では suspended のほか interrupted (着信・アプリ切り替え後) にもなる
  if (actx.state !== 'running') {
    const p = actx.resume();
    if (p && p.catch) p.catch(() => {});
  }
  if (!audioUnlocked) {
    // 無音のバッファを再生して、音声出力を確実に有効化する
    const src = actx.createBufferSource();
    src.buffer = actx.createBuffer(1, 1, 22050);
    src.connect(actx.destination);
    src.start(0);
    if (actx.state === 'running') audioUnlocked = true;
  }
}

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function toneHit(t, dest, o) {
  const osc = actx.createOscillator(), g = actx.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f1, t);
  if (o.f2 && o.f2 !== o.f1) osc.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
  g.gain.setValueAtTime(o.vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + o.dur);
  osc.connect(g); g.connect(dest);
  osc.start(t); osc.stop(t + o.dur + 0.02);
}

function noiseHit(t, dest, o) {
  const s = actx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  const f = actx.createBiquadFilter();
  f.type = o.type || 'highpass';
  f.frequency.value = o.freq;
  f.Q.value = o.q || 0.7;
  const g = actx.createGain();
  g.gain.setValueAtTime(o.vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + o.dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t, Math.random() * 0.5); s.stop(t + o.dur + 0.02);
}

const inst = {
  stick(t, d, accent) {
    toneHit(t, d, { type: 'square', f1: accent ? 1900 : 1400, dur: 0.04, vol: 0.16 });
    noiseHit(t, d, { freq: 3000, vol: 0.12, dur: 0.03 });
  },
  kick(t, d) { toneHit(t, d, { f1: 150, f2: 42, dur: 0.26, vol: 0.9 }); },
  snare(t, d, vol) {
    noiseHit(t, d, { type: 'bandpass', freq: 1900, q: 0.6, vol: 0.5 * vol, dur: 0.17 });
    toneHit(t, d, { type: 'triangle', f1: 200, f2: 120, dur: 0.09, vol: 0.28 * vol });
  },
  hat(t, d) { noiseHit(t, d, { freq: 7500, vol: 0.11, dur: 0.04 }); },
  ohat(t, d) { noiseHit(t, d, { freq: 6500, vol: 0.1, dur: 0.2 }); },
  crash(t, d) { noiseHit(t, d, { freq: 4200, vol: 0.22, dur: 1.3 }); },
  bass(t, d, midi, dur) {
    const osc = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.frequency.value = 520;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(f); f.connect(g); g.connect(d);
    osc.start(t); osc.stop(t + dur + 0.02);
  },
  pad(t, d, midis, dur) {
    for (const m of midis) {
      const osc = actx.createOscillator(), g = actx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = mtof(m);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.06);
      g.gain.setValueAtTime(0.05, t + dur * 0.8);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(d);
      osc.start(t); osc.stop(t + dur + 0.02);
    }
  },
  lead(t, d, midi, dur) {
    const f = actx.createBiquadFilter(), g = actx.createGain();
    f.type = 'lowpass'; f.frequency.value = 2600;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.045, t + Math.min(0.14, dur));
    g.gain.setValueAtTime(0.045, t + dur);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.09);
    f.connect(g); g.connect(d);
    for (const [type, cents] of [['square', 0], ['sawtooth', 8]]) {
      const osc = actx.createOscillator();
      osc.type = type;
      osc.frequency.value = mtof(midi);
      osc.detune.value = cents;
      osc.connect(f);
      osc.start(t); osc.stop(t + dur + 0.12);
    }
  },
};

const sfx = {
  ok() { return actx && actx.state === 'running'; },
  click() { if (this.ok()) toneHit(actx.currentTime, master, { type: 'triangle', f1: 880, f2: 1320, dur: 0.07, vol: 0.12 }); },
  tick() { if (this.ok()) inst.stick(actx.currentTime, master, false); },
  tap(judge) {
    if (!this.ok() || !state.settings.sfx) return;
    const t = actx.currentTime;
    noiseHit(t, master, { freq: 6000, vol: 0.2, dur: 0.08 });
    if (judge === 'perfect') toneHit(t, master, { f1: 1568, dur: 0.09, vol: 0.06 });
  },
  next() { if (this.ok()) [659, 880].forEach((f, i) => toneHit(actx.currentTime + i * 0.1, master, { type: 'triangle', f1: f, dur: 0.16, vol: 0.13 })); },
  rank() { if (this.ok()) [784, 988, 1175, 1568].forEach((f, i) => toneHit(actx.currentTime + i * 0.07, master, { f1: f, dur: 0.22, vol: 0.12 })); },
  reveal() { if (this.ok()) { inst.kick(actx.currentTime, master); inst.crash(actx.currentTime, master); } },
  drumroll(sec) {
    if (!this.ok()) return;
    const t0 = actx.currentTime;
    for (let t = 0; t < sec; t += 0.055) inst.snare(t0 + t, master, 0.25 + 0.5 * (t / sec));
  },
  fanfare() {
    if (!this.ok()) return;
    const t0 = actx.currentTime;
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => toneHit(t0 + i * 0.12, master, { type: 'triangle', f1: f, dur: 0.2, vol: 0.14 }));
    inst.pad(t0 + 0.72, master, [60, 64, 67, 72, 76], 1.4);
    inst.crash(t0 + 0.72, master);
  },
};

// ---------------------------------------------------------------
// 内蔵ビート: 曲データと譜面の自動生成
//   メロディを乱数で作り、その音の出るタイミングをそのまま譜面にする
// ---------------------------------------------------------------
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const PENTA = [0, 2, 4, 7, 9];

// form: [セクション, 小節数]  A=Aメロ, B=Bメロ, S=サビ (みんなの顔が流れる)
const SONGS = [
  {
    name: 'ゆるっとポップ', desc: 'ゆっくり・はじめての人に', bpm: 104, root: 60, seed: 7,
    form: [['intro', 2], ['A', 8], ['B', 8], ['S', 8], ['outro', 1]],
    prog: { A: [0, 4, 5, 3], B: [3, 4, 2, 5], S: [0, 4, 5, 3] },
  },
  {
    name: 'パーティーナイト', desc: 'ノリノリの4つ打ち', bpm: 126, root: 65, seed: 21,
    form: [['intro', 2], ['A', 8], ['B', 4], ['S', 8], ['A', 4], ['S', 8], ['outro', 1]],
    prog: { A: [5, 3, 0, 4], B: [3, 4, 5, 5], S: [5, 3, 0, 4] },
  },
  {
    name: '爆速ロック', desc: '速い！腕に自信のある人に', bpm: 156, root: 64, seed: 99, fast: true,
    form: [['intro', 2], ['A', 8], ['B', 8], ['S', 8], ['B', 4], ['S', 8], ['outro', 1]],
    prog: { A: [0, 4, 5, 3], B: [5, 3, 4, 4], S: [3, 4, 2, 5] },
  },
];

// 1小節 = 16ステップ (16分音符) でのリズムパターン
const RHYTHMS = {
  A: [[0, 4, 8, 12], [0, 4, 8, 10, 12], [0, 2, 4, 8, 12], [0, 4, 6, 8, 12], [0, 4, 8, 12, 14]],
  B: [[0, 2, 4, 8, 10, 12], [0, 4, 6, 8, 12, 14], [0, 2, 4, 6, 8, 12], [0, 4, 8, 10, 12, 14]],
  S: [[0, 2, 4, 6, 8, 12, 14], [0, 2, 4, 8, 10, 12, 14], [0, 3, 6, 8, 12, 14], [0, 2, 4, 6, 8, 10, 12]],
  fill: [[0, 2, 4, 6, 8, 10, 12, 13, 14, 15], [0, 4, 8, 10, 12, 13, 14, 15]],
  fillFast: [[0, 2, 4, 6, 8, 10, 12, 14], [0, 4, 8, 10, 12, 14]],
};

function degreeChord(root, deg) {
  return [0, 2, 4].map((k) => {
    const d = deg + k;
    return root + MAJOR[d % 7] + 12 * Math.floor(d / 7);
  });
}

const pentaNote = (root, idx) => root + PENTA[((idx % 5) + 5) % 5] + 12 * Math.floor(idx / 5);

// メロディの上がり下がりに合わせてレーンを動かす
function assignLanes(list) {
  let lane = 1, prev = null;
  for (const n of list) {
    if (prev !== null) {
      if (n.pitch > prev) lane++;
      else if (n.pitch < prev) lane--;
    }
    if (lane > LANES - 1) lane = LANES - 2;
    if (lane < 0) lane = 1;
    n.lane = lane;
    prev = n.pitch;
  }
}

function buildSong(song, diff) {
  const rng = mulberry32(song.seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const ev = [];        // 音を鳴らすイベント { beat, type, a, b }
  const melody = [];
  const fever = [];     // サビの範囲 [開始拍, 終了拍]
  let bar = 0, pi = 4;

  const genBar = (rhythm, lo, hi) => rhythm.map((step) => {
    pi = clamp(pi + pick([-2, -1, -1, 0, 1, 1, 2]), lo, hi);
    return { step, pi };
  });

  for (const [sec, bars] of song.form) {
    const b0 = bar * 4;
    if (sec === 'intro') {
      for (let i = 0; i < bars * 4; i++) ev.push({ beat: b0 + i, type: 'stick', a: i % 4 === 0 });
      ev.push({ beat: b0, type: 'pad', a: degreeChord(song.root, 0), b: bars * 4 });
    } else if (sec === 'outro') {
      const chord = degreeChord(song.root, 0);
      ev.push({ beat: b0, type: 'crash' }, { beat: b0, type: 'kick' });
      ev.push({ beat: b0, type: 'pad', a: chord.concat(song.root + 12), b: 4 });
      ev.push({ beat: b0, type: 'bass', a: chord[0] - 24, b: 3 });
      melody.push({ beat: b0, step: 0, pitch: song.root + 12, dur: 2, fever: false });
    } else {
      const isS = sec === 'S';
      const prog = song.prog[sec];
      if (isS) { fever.push([b0, b0 + bars * 4]); ev.push({ beat: b0, type: 'crash' }); }
      const phrase = [];
      for (let b = 0; b < bars; b++) {
        const bb = b0 + b * 4;
        const last = b === bars - 1;
        const chord = degreeChord(song.root, prog[b % prog.length]);

        // メロディ: 4小節フレーズで、3小節目は1小節目のモチーフを繰り返す
        let cells;
        if (last) cells = genBar(pick(song.fast ? RHYTHMS.fillFast : RHYTHMS.fill), 2, 9);
        else if (b % 4 === 2 && phrase[0]) cells = phrase[0];
        else cells = genBar(pick(RHYTHMS[sec]), isS ? 3 : 1, isS ? 10 : 8);
        phrase[b % 4] = cells;
        cells.forEach((c, i) => {
          const next = i + 1 < cells.length ? cells[i + 1].step : 16;
          melody.push({
            beat: bb + c.step / 4, step: c.step, pitch: pentaNote(song.root, c.pi),
            dur: Math.min((next - c.step) / 4, 1.5) * 0.9, fever: isS,
          });
        });

        // ドラム
        const kicks = sec === 'A' ? [0, 8, 10] : sec === 'B' ? [0, 6, 8] : [0, 4, 8, 12];
        const fillSteps = last ? (song.fast ? [12, 14] : [12, 13, 14, 15]) : [];
        for (const s of kicks) ev.push({ beat: bb + s / 4, type: 'kick' });
        for (const s of [4, 12]) if (!fillSteps.includes(s)) ev.push({ beat: bb + s / 4, type: 'snare', a: 1 });
        fillSteps.forEach((s, i) => ev.push({ beat: bb + s / 4, type: 'snare', a: 0.55 + 0.45 * (i / fillSteps.length) }));
        for (let s = 0; s < 16; s += 2) {
          if (fillSteps.includes(s)) continue;
          ev.push({ beat: bb + s / 4, type: isS && s % 4 === 2 ? 'ohat' : 'hat' });
        }

        // ベースとコード
        const bassSteps = sec === 'A' ? [0, 8, 11] : sec === 'B' ? [0, 4, 8, 12] : [0, 2, 4, 6, 8, 10, 12, 14];
        bassSteps.forEach((s, i) => ev.push({
          beat: bb + s / 4, type: 'bass',
          a: chord[0] - 24 + (isS && i % 2 === 1 ? 12 : 0), b: isS ? 0.45 : 0.9,
        }));
        ev.push({ beat: bb, type: 'pad', a: isS ? chord.concat(chord[0] + 12) : chord, b: 4 });
      }
    }
    bar += bars;
  }

  for (const m of melody) ev.push({ beat: m.beat, type: 'lead', a: m.pitch, b: m.dur });
  ev.sort((p, q) => p.beat - q.beat);

  // むずかしさに応じて、メロディのどの音をノーツにするかを間引く
  const keep = diff === 'easy' ? (m) => m.step % 4 === 0 : diff === 'normal' ? (m) => m.step % 2 === 0 : () => true;
  const notes = melody.filter(keep).map((m) => ({ beat: m.beat, pitch: m.pitch, fever: m.fever, step: m.step }));
  assignLanes(notes);
  if (diff === 'hard') addDoubles(notes);

  return { events: ev, notes, fever, totalBeats: bar * 4, leadBeats: 8 };
}

// むずかしい: サビの小節頭は同時押し
function addDoubles(notes) {
  const extra = [];
  for (const n of notes) {
    if (n.fever && n.step === 0) extra.push({ beat: n.beat, pitch: n.pitch, fever: true, step: 0, lane: (n.lane + 2) % LANES });
  }
  notes.push(...extra);
  notes.sort((p, q) => p.beat - q.beat);
}

// ---------------------------------------------------------------
// カラオケモード: 測ったテンポに合わせてリズムパターンを並べる
// ---------------------------------------------------------------
const K_PATTERNS = {
  easy: [[0, 4, 8, 12], [0, 4, 8, 12], [0, 8, 12], [0, 4, 8], [0, 4, 8, 10, 12]],
  normal: [[0, 4, 8, 10, 12], [0, 2, 4, 8, 12], [0, 4, 6, 8, 12, 14], [0, 2, 4, 8, 10, 12], [0, 4, 8, 12]],
  hard: [[0, 2, 4, 6, 8, 12, 14], [0, 3, 6, 8, 11, 14], [0, 2, 4, 6, 8, 10, 12, 14], [0, 2, 3, 4, 8, 10, 11, 12], [0, 4, 6, 8, 10, 12, 14]],
};

function buildKaraokeChart(bpm, diff, lengthSec, seed) {
  const rng = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const spb = 60 / bpm;
  const leadBeats = Math.ceil((APPROACH[diff] + 1.2) / spb / 4) * 4;
  const total = lengthSec > 0 ? lengthSec : 600;
  const bars = Math.max(4, Math.floor((total / spb - leadBeats) / 4));
  let pool = K_PATTERNS[diff];
  if (diff === 'hard' && bpm > 150) pool = pool.map((p) => p.filter((s) => s % 2 === 0));   // 速い曲の16分は無理なので8分に

  const notes = [], fever = [];
  let lane = 1, pair = [pool[0], pool[1]];
  for (let b = 0; b < bars; b++) {
    const isFever = Math.floor(b / 8) % 2 === 1;   // 8小節ごとに「みんなの顔」タイム
    if (isFever && b % 8 === 0) fever.push([leadBeats + b * 4, leadBeats + (b + 8) * 4]);
    if (b % 4 === 0) pair = [pick(pool), pick(pool)];
    const pat = pair[b % 2];
    for (const step of pat) {
      lane = clamp(lane + pick([-1, -1, 1, 1, 0, 2, -2]), 0, LANES - 1);
      notes.push({ beat: leadBeats + b * 4 + step / 4, fever: isFever, step, lane });
    }
  }
  if (diff === 'hard') addDoubles(notes);
  return { notes, fever, totalBeats: leadBeats + bars * 4, leadBeats };
}

// ---------------------------------------------------------------
// 音楽の再生 (少し先までのイベントを順次スケジュールする)
// ---------------------------------------------------------------
const music = { bus: null, events: null, idx: 0, origin: 0, spb: 0, timer: null };

function musicStart(events, origin, spb) {
  musicStop();
  music.bus = actx.createGain();
  music.bus.gain.value = 0.8;
  music.bus.connect(master);
  Object.assign(music, { events, idx: 0, origin, spb });
  music.timer = setInterval(musicPump, 40);
  musicPump();
}

function musicPump() {
  if (!music.events || !actx) return;
  const horizon = actx.currentTime + 0.3;
  while (music.idx < music.events.length) {
    const e = music.events[music.idx];
    const t = music.origin + e.beat * music.spb;
    if (t > horizon) break;
    const at = Math.max(t, actx.currentTime), d = music.bus;
    switch (e.type) {
      case 'stick': inst.stick(at, d, e.a); break;
      case 'kick': inst.kick(at, d); break;
      case 'snare': inst.snare(at, d, e.a); break;
      case 'hat': inst.hat(at, d); break;
      case 'ohat': inst.ohat(at, d); break;
      case 'crash': inst.crash(at, d); break;
      case 'bass': inst.bass(at, d, e.a, e.b * music.spb); break;
      case 'pad': inst.pad(at, d, e.a, e.b * music.spb); break;
      case 'lead': inst.lead(at, d, e.a, e.b * music.spb); break;
    }
    music.idx++;
  }
}

function musicStop() {
  clearInterval(music.timer);
  music.timer = null;
  music.events = null;
  if (music.bus) {
    const bus = music.bus;
    music.bus = null;
    try { bus.gain.setTargetAtTime(0, actx.currentTime, 0.03); } catch (e) { /* 無視 */ }
    setTimeout(() => bus.disconnect(), 400);
  }
}

// ---------------------------------------------------------------
// 画面まわり
// ---------------------------------------------------------------
const ui = { screen: 'title' };
let session = null;   // { order: [playerId], idx, results: [] }
let play = null;      // プレイ中の状態
const tempo = { taps: [], bpm: 120, anchorT: null, anchorI: 0, ready: false };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 'scr-' + name));
  $('btn-pause').style.display = name === 'play' ? 'block' : 'none';
  ui.screen = name;
}

let toastTimer = null;
function toast(msg) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom) + 90px);transform:translateX(-50%);z-index:20;' +
      'background:rgba(0,0,0,0.85);border:1px solid rgba(255,255,255,0.25);border-radius:12px;padding:10px 16px;font-size:14px;' +
      'max-width:86%;text-align:center;pointer-events:none;transition:opacity .25s';
    $('app').appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

function bindSeg(id, get, set) {
  const el = $(id);
  const refresh = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    set(b.dataset.v);
    saveState();
    sfx.click();
    refresh();
  });
  refresh();
  return refresh;
}

// ----- タイトル -----
function showTitle() {
  stopConfetti();
  const row = $('title-faces');
  row.textContent = '';
  state.players.slice(0, 8).forEach((p) => row.appendChild(avatarCanvas(p.id, 44)));
  showScreen('title');
}

// ----- メンバー -----
function renderPlayers() {
  const list = $('player-list');
  list.textContent = '';
  if (!state.players.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'まだメンバーがいません。\n「＋ メンバーを追加」から、名前と顔写真を登録しよう！';
    e.style.whiteSpace = 'pre-line';
    list.appendChild(e);
  }
  for (const p of state.players) {
    const row = document.createElement('div');
    row.className = 'player' + (p.active === false ? ' off' : '');
    const main = document.createElement('button');
    main.className = 'p-main';
    main.appendChild(avatarCanvas(p.id, 46));
    const txt = document.createElement('div');
    txt.style.minWidth = '0';
    const nm = document.createElement('div');
    nm.className = 'p-name'; nm.textContent = p.name;
    const ed = document.createElement('div');
    ed.className = 'p-edit'; ed.textContent = p.photo ? 'タップで編集' : 'タップで写真を登録';
    txt.append(nm, ed);
    main.appendChild(txt);
    main.addEventListener('click', () => { sfx.click(); openEdit(p); });
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.className = 'p-join'; chk.checked = p.active !== false;
    chk.setAttribute('aria-label', p.name + ' の参加');
    chk.addEventListener('change', () => { p.active = chk.checked; saveState(); renderPlayers(); });
    row.append(main, chk);
    list.appendChild(row);
  }
}

let editing = null;

function openEdit(p) {
  editing = p
    ? { id: p.id, name: p.name, photo: p.photo, color: p.color }
    : { id: null, name: '', photo: null, color: AVATAR_COLORS[state.players.length % AVATAR_COLORS.length] };
  $('edit-title').textContent = p ? 'メンバーを編集' : 'メンバーを追加';
  $('edit-name').value = editing.name;
  $('btn-edit-delete').style.display = p ? 'block' : 'none';
  refreshEditAvatar();
  $('modal-edit').classList.add('on');
}

function refreshEditAvatar() {
  const tmp = { id: '__edit', name: $('edit-name').value || '？', photo: editing.photo, color: editing.color };
  buildSprite(tmp).then(() => setAvatar($('edit-avatar'), '__edit', 110));
}

function saveEdit() {
  const name = $('edit-name').value.trim() || 'メンバー' + (state.players.length + 1);
  let p = editing.id ? playerById(editing.id) : null;
  if (!p) {
    p = { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), active: true };
    state.players.push(p);
  }
  Object.assign(p, { name, photo: editing.photo, color: editing.color });
  $('modal-edit').classList.remove('on');
  if (!saveState()) toast('保存容量がいっぱいです。この写真は今回だけ使えます');
  buildSprite(p).then(renderPlayers);
}

function deleteEdit() {
  if (!editing.id || !confirm('このメンバーを削除しますか？')) return;
  state.players = state.players.filter((p) => p.id !== editing.id);
  sprites.delete(editing.id);
  saveState();
  $('modal-edit').classList.remove('on');
  renderPlayers();
}

// ----- 写真の切り抜き -----
const CROP_V = 300;
const crop = { work: null, iw: 0, ih: 0, scale: 1, min: 1, max: 5, x: 0, y: 0, ptr: new Map(), dist: 0, resolve: null };

function openCropper(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // スマホの写真は大きいので、先に縮小しておく
      const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = document.createElement('canvas');
      w.width = Math.max(1, Math.round(img.naturalWidth * k));
      w.height = Math.max(1, Math.round(img.naturalHeight * k));
      w.getContext('2d').drawImage(img, 0, 0, w.width, w.height);
      crop.work = w; crop.iw = w.width; crop.ih = w.height;
      crop.min = Math.max(CROP_V / crop.iw, CROP_V / crop.ih);
      crop.max = crop.min * 5;
      crop.scale = crop.min; crop.x = 0; crop.y = 0;
      crop.ptr.clear();
      crop.resolve = resolve;
      $('crop-zoom').value = 0;
      $('modal-crop').classList.add('on');
      drawCrop();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('この画像は読み込めませんでした');
      resolve(null);
    };
    img.src = url;
  });
}

function cropClamp() {
  crop.scale = clamp(crop.scale, crop.min, crop.max);
  const mx = (crop.iw * crop.scale - CROP_V) / 2, my = (crop.ih * crop.scale - CROP_V) / 2;
  crop.x = clamp(crop.x, -mx, mx);
  crop.y = clamp(crop.y, -my, my);
}

function drawCropImage(c, k) {
  const w = crop.iw * crop.scale, h = crop.ih * crop.scale;
  c.drawImage(crop.work, (CROP_V / 2 + crop.x - w / 2) * k, (CROP_V / 2 + crop.y - h / 2) * k, w * k, h * k);
}

function drawCrop() {
  cropClamp();
  const cv = $('crop-canvas');
  if (cv.width !== CROP_V * 2) { cv.width = cv.height = CROP_V * 2; }
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  drawCropImage(c, 2);
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.fillStyle = 'rgba(0,0,0,0.6)';
  c.beginPath();
  c.rect(0, 0, CROP_V, CROP_V);
  c.arc(CROP_V / 2, CROP_V / 2, CROP_V / 2 - 2, 0, TAU, true);
  c.fill();
  c.strokeStyle = '#fff'; c.lineWidth = 3;
  c.beginPath(); c.arc(CROP_V / 2, CROP_V / 2, CROP_V / 2 - 2, 0, TAU); c.stroke();
  c.strokeStyle = 'rgba(63,224,255,0.9)'; c.lineWidth = 2;
  c.setLineDash([8, 6]);
  c.beginPath(); c.moveTo(CROP_V * 0.2, CROP_V * 0.42); c.lineTo(CROP_V * 0.8, CROP_V * 0.42); c.stroke();
  c.setLineDash([]);
  c.fillStyle = 'rgba(63,224,255,0.95)';
  c.font = 'bold 11px sans-serif';
  c.fillText('目の高さ', CROP_V * 0.2, CROP_V * 0.42 - 5);
}

function closeCropper(ok) {
  let out = null;
  if (ok && crop.work) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    drawCropImage(c.getContext('2d'), 256 / CROP_V);
    out = c.toDataURL('image/jpeg', 0.85);
  }
  $('modal-crop').classList.remove('on');
  crop.work = null;
  if (crop.resolve) crop.resolve(out);
  crop.resolve = null;
}

function bindCropper() {
  const cv = $('crop-canvas');
  const syncSlider = () => { $('crop-zoom').value = 100 * Math.log(crop.scale / crop.min) / Math.log(crop.max / crop.min); };
  const pinchDist = () => {
    const [a, b] = Array.from(crop.ptr.values());
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    crop.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (crop.ptr.size === 2) crop.dist = pinchDist();
  });
  cv.addEventListener('pointermove', (e) => {
    const p = crop.ptr.get(e.pointerId);
    if (!p || !crop.work) return;
    const k = CROP_V / cv.getBoundingClientRect().width;
    if (crop.ptr.size === 1) {
      crop.x += (e.clientX - p.x) * k;
      crop.y += (e.clientY - p.y) * k;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (crop.ptr.size === 2) {
      const d = pinchDist();
      if (crop.dist > 0) crop.scale *= d / crop.dist;
      crop.dist = d;
      cropClamp();
      syncSlider();
    }
    drawCrop();
  });
  const up = (e) => { crop.ptr.delete(e.pointerId); crop.dist = 0; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    crop.scale *= e.deltaY < 0 ? 1.08 : 1 / 1.08;
    cropClamp(); syncSlider(); drawCrop();
  }, { passive: false });
  $('crop-zoom').addEventListener('input', (e) => {
    crop.scale = crop.min * Math.pow(crop.max / crop.min, e.target.value / 100);
    drawCrop();
  });
  $('btn-crop-ok').addEventListener('click', () => closeCropper(true));
  $('btn-crop-cancel').addEventListener('click', () => closeCropper(false));
}

// ----- あそびかた設定 -----
let refreshSetup = () => {};

function bindSetup() {
  const s = state.settings;
  const segSong = $('seg-song');
  SONGS.forEach((song, i) => {
    const b = document.createElement('button');
    b.dataset.v = String(i);
    b.textContent = `${song.name}（BPM ${song.bpm}）`;
    const sm = document.createElement('small');
    sm.textContent = song.desc;
    b.appendChild(sm);
    segSong.appendChild(b);
  });
  const panels = () => {
    const k = s.mode === 'karaoke';
    $('panel-song').style.display = k ? 'none' : 'block';
    $('panel-length').style.display = k ? 'block' : 'none';
    $('offset-box').style.display = k ? 'none' : 'block';
    $('mode-hint').textContent = k
      ? 'カラオケ機で曲を流し、そのビートをタップしてテンポを測ります。歌う人の横で、タンバリン係として遊べます。'
      : 'ゲームが演奏するオリジナル曲で遊びます。1人あたり約1分。';
  };
  const segs = [
    bindSeg('seg-mode', () => s.mode, (v) => { s.mode = v; panels(); }),
    bindSeg('seg-song', () => s.song, (v) => { s.song = Number(v); }),
    bindSeg('seg-length', () => s.length, (v) => { s.length = Number(v); }),
    bindSeg('seg-diff', () => s.diff, (v) => { s.diff = v; }),
  ];
  $('chk-shuffle').addEventListener('change', (e) => { s.shuffle = e.target.checked; saveState(); });
  $('chk-sfx').addEventListener('change', (e) => { s.sfx = e.target.checked; saveState(); });
  $('rng-offset').addEventListener('input', (e) => {
    s.offset = Number(e.target.value);
    $('offset-val').textContent = (s.offset > 0 ? '+' : '') + s.offset;
    saveState();
  });
  refreshSetup = () => {
    segs.forEach((f) => f());
    panels();
    $('chk-shuffle').checked = s.shuffle;
    $('chk-sfx').checked = s.sfx;
    $('rng-offset').value = s.offset;
    $('offset-val').textContent = (s.offset > 0 ? '+' : '') + s.offset;
  };
  refreshSetup();
}

// ----- セッション (全員ぶんのプレイ) -----
function beginSession() {
  const ids = activePlayers().map((p) => p.id);
  if (state.settings.shuffle) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  session = { order: ids, idx: 0, results: [] };
  tempo.ready = false;
  showNext();
}

const currentPlayer = () => playerById(session.order[session.idx]);

function showNext() {
  stopConfetti();
  const p = currentPlayer(), s = state.settings;
  const karaoke = s.mode === 'karaoke';
  setAvatar($('next-avatar'), p.id, 150);
  $('next-avatar').className = 'pop';
  $('next-name').textContent = p.name + ' さん';
  const what = karaoke ? 'カラオケに合わせる' : SONGS[s.song].name;
  $('next-info').textContent = `${session.idx + 1} / ${session.order.length} 人目 ・ ${what} ・ ${DIFF_LABEL[s.diff]}\nスマホを渡してね`;
  $('next-info').style.whiteSpace = 'pre-line';
  $('btn-go').textContent = !karaoke ? 'スタート！' : tempo.ready ? `BPM ${tempo.bpm} のままスタート！` : 'テンポを合わせる';
  $('btn-retempo').style.display = karaoke && tempo.ready ? 'block' : 'none';
  showScreen('next');
  sfx.next();
}

// ----- テンポ計測 -----
function openTempo() {
  tempo.taps = [];
  $('bpm-input').value = tempo.bpm;
  $('chk-round').checked = state.settings.roundBpm;
  $('tempo-hint').textContent = '曲のビートに合わせてタップしてね';
  showScreen('tempo');
}

function tempoTap() {
  const t = perfNow();
  const taps = tempo.taps;
  if (taps.length && t - taps[taps.length - 1] > 2.5) taps.length = 0;   // 間があいたら測り直し
  taps.push(t);
  if (taps.length > 16) taps.shift();
  sfx.tick();
  const n = taps.length;
  if (n < 2) { $('tempo-hint').textContent = 'そのまま続けてタップ！'; return; }

  // タップ時刻を直線にあてはめて、1拍の長さを求める
  const mi = (n - 1) / 2, mt = taps.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  taps.forEach((v, i) => { num += (i - mi) * (v - mt); den += (i - mi) * (i - mi); });
  let bpm = 60 / (num / den);
  bpm = state.settings.roundBpm ? Math.round(bpm) : Math.round(bpm * 10) / 10;
  tempo.bpm = clamp(bpm, 50, 240);
  tempo.anchorT = mt;
  tempo.anchorI = mi;
  $('bpm-input').value = tempo.bpm;
  $('tempo-hint').textContent = n < 8 ? `いい感じ！あと ${8 - n} 回` : 'OK！丸の光り方が曲と合っていたらスタート';
}

function setBpm(v) {
  if (!isFinite(v)) return;
  tempo.bpm = clamp(Math.round(v * 10) / 10, 50, 240);
  $('bpm-input').value = tempo.bpm;
}

// 測ったテンポでの「拍の位置」(0〜1)。丸を光らせて、曲と合っているか目で確かめてもらう
function tempoPhase(t) {
  if (tempo.anchorT === null) return null;
  const spb = 60 / tempo.bpm;
  const k = (t - tempo.anchorT) / spb + tempo.anchorI;
  return k - Math.floor(k);
}

function updateTapPad(t) {
  const ph = tempoPhase(t);
  const glow = ph === null ? 0 : Math.pow(1 - ph, 3);
  const pad = $('tap-pad');
  pad.style.boxShadow = `0 0 ${10 + glow * 50}px rgba(63,224,255,${0.25 + glow * 0.7})`;
  pad.style.transform = `scale(${1 + glow * 0.05})`;
}

// ---------------------------------------------------------------
// プレイ
// ---------------------------------------------------------------
let clockSafeUntil = 0;

// 「いまスピーカーから出ている音」の時刻。出力の遅れを差し引いて判定のズレを防ぐ
function audioNow() {
  const t = actx.currentTime;
  if (actx.getOutputTimestamp && perfNow() > clockSafeUntil) {
    const ts = actx.getOutputTimestamp();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      const v = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      if (Math.abs(v - t) < 0.5) return v;
    }
  }
  return t - (actx.outputLatency || actx.baseLatency || 0);
}

function startTurn() {
  const begin = () => {
    const s = state.settings, p = currentPlayer();
    const karaoke = s.mode === 'karaoke';
    const audioOk = actx && actx.state === 'running';
    let chart, spb;
    if (karaoke) {
      spb = 60 / tempo.bpm;
      chart = buildKaraokeChart(tempo.bpm, s.diff, s.length, (Date.now() & 0xffff) + session.idx);
    } else {
      spb = 60 / SONGS[s.song].bpm;
      chart = buildSong(SONGS[s.song], s.diff);
    }
    for (const n of chart.notes) n.time = n.beat * spb;

    // サビ・フィーバー中は全員の顔、それ以外は自分の顔
    const rng = mulberry32(session.idx * 977 + 13);
    const everyone = session.order;
    for (const n of chart.notes) n.face = n.fever ? everyone[Math.floor(rng() * everyone.length)] : p.id;

    play = {
      mode: s.mode, diff: s.diff, player: p, spb,
      clock: !karaoke && audioOk ? 'audio' : 'perf',
      notes: chart.notes, fever: chart.fever, leadBeats: chart.leadBeats,
      duration: chart.totalBeats * spb + (karaoke ? 0.5 : 1.2),
      endless: karaoke && s.length === 0,
      approach: APPROACH[s.diff],
      offset: karaoke ? 0 : s.offset / 1000,
      head: 0, wsum: 0, combo: 0, maxCombo: 0, missStreak: 0, judged: 0,
      counts: { perfect: 0, great: 0, good: 0, miss: 0 },
      offSum: 0, offN: 0,
      paused: false, done: false,
      laneFlash: [0, 0, 0, 0], fx: [], judgeFx: null, comboAt: 0, hitAt: 0, banner: null, wasFever: false,
    };

    if (karaoke) {
      // 測った拍の位置のうち、いちばん近い「次の拍」を曲の0拍目にする
      const now = perfNow();
      if (tempo.anchorT === null) { tempo.anchorT = now; tempo.anchorI = 0; }
      const k0 = Math.ceil((now + 0.05 - tempo.anchorT) / spb + tempo.anchorI);
      play.origin = tempo.anchorT + (k0 - tempo.anchorI) * spb;
    } else if (play.clock === 'audio') {
      play.origin = actx.currentTime + 0.5;
      musicStart(chart.events, play.origin, spb);
    } else {
      play.origin = perfNow() + 0.5;
      toast('音を再生できないため、無音でプレイします');
    }
    play.origin0 = play.origin;
    showScreen('play');
  };
  holdSuspend = false;
  initAudio();
  if (actx && actx.state !== 'running') actx.resume().then(begin, begin);
  else begin();
}

function songTime() {
  const c = play.clock === 'audio' ? audioNow() : perfNow();
  return c - play.origin - play.offset;
}

const isFeverAt = (beat) => play.fever.some(([a, b]) => beat >= a && beat < b);

// 途中終了・「曲の最後まで」のときは、叩いたぶんだけで採点する。
// ただし数個だけ叩いて満点、とならないように最低ノーツ数を設ける
const MIN_NOTES = 60;

function scoreOf(total) {
  return Math.round(1e6 * (0.9 * play.wsum + 0.1 * play.maxCombo) / Math.max(total, 1));
}

const partialTotal = () => Math.max(play.judged, Math.min(play.notes.length, MIN_NOTES));

function liveScore() {
  return scoreOf(play.endless ? partialTotal() : play.notes.length);
}

function judgeNote(n, judge, dt) {
  n.judged = true;
  n.result = judge;
  play.judged++;
  play.counts[judge]++;
  play.wsum += WEIGHT[judge];
  const now = perfNow();
  if (judge === 'miss') {
    play.combo = 0;
    play.missStreak++;
    play.fx.push({ type: 'ghost', lane: n.lane, face: n.face, at: now });
  } else {
    play.combo++;
    play.missStreak = 0;
    play.maxCombo = Math.max(play.maxCombo, play.combo);
    play.comboAt = now;
    play.hitAt = now;
    play.offSum += dt; play.offN++;
    play.fx.push({ type: 'hit', lane: n.lane, face: n.face, at: now, judge });
    if (play.combo > 0 && play.combo % 50 === 0) play.banner = { text: `${play.combo} COMBO!!`, at: now };
  }
  play.judgeFx = { judge, at: now };
}

function tapLane(lane) {
  if (!play || play.paused || play.done) return;
  const t = songTime();
  play.laneFlash[lane] = perfNow();
  const find = (ok) => {
    for (let i = play.head; i < play.notes.length; i++) {
      const n = play.notes[i];
      if (n.time - t > WINDOW.good) break;
      if (!n.judged && ok(n) && Math.abs(n.time - t) <= WINDOW.good) return n;
    }
    return null;
  };
  let n = find((m) => m.lane === lane);
  if (!n && play.diff === 'easy') n = find((m) => Math.abs(m.lane - lane) === 1);   // かんたん: となりのレーンでもOK

  let judge = null;
  if (n) {
    const dt = t - n.time, a = Math.abs(dt);
    judge = a <= WINDOW.perfect ? 'perfect' : a <= WINDOW.great ? 'great' : 'good';
    judgeNote(n, judge, dt);
    // カラオケモード: プレイヤーのタップから拍のズレを少しずつ補正する (テンポ計測の誤差対策)
    if (play.mode === 'karaoke') play.origin += dt * 0.15;
  } else if (play.mode === 'karaoke') {
    const grid = play.spb / 2;
    const ph = t / grid - Math.round(t / grid);
    if (Math.abs(ph) < 0.45) play.origin += ph * grid * 0.06;
  }
  sfx.tap(judge);
}

function updatePlay() {
  const t = songTime();
  const notes = play.notes;
  for (let i = play.head; i < notes.length; i++) {
    const n = notes[i];
    if (n.time > t - WINDOW.good) break;
    if (!n.judged) judgeNote(n, 'miss', 0);
  }
  while (play.head < notes.length && notes[play.head].judged) play.head++;

  const fever = isFeverAt(t / play.spb);
  if (fever && !play.wasFever && session.order.length > 1) {
    play.banner = { text: play.mode === 'karaoke' ? 'みんなでフィーバー！' : 'サビ！ みんな集合！', at: perfNow() };
  }
  play.wasFever = fever;

  const now = perfNow();
  play.fx = play.fx.filter((f) => now - f.at < 0.6);
  if (t > play.duration) finishTurn(false);
}

function pauseGame() {
  if (ui.screen !== 'play' || !play || play.paused || play.done) return;
  play.paused = true;
  if (play.clock === 'audio') { holdSuspend = true; actx.suspend(); }
  $('pause-note').textContent = play.mode === 'karaoke' ? '※ カラオケの曲は進み続けるので、ポーズ中も譜面の時間は止まりません' : '';
  showScreen('pause');
}

function resumeGame() {
  const go = () => { clockSafeUntil = perfNow() + 0.4; play.paused = false; showScreen('play'); };
  holdSuspend = false;
  if (play.clock === 'audio') actx.resume().then(go, go);
  else go();
}

// 途中でやめる・やりなおすときの後片づけ
function abortPlay() {
  musicStop();
  holdSuspend = false;
  if (actx && actx.state !== 'running') actx.resume().catch(() => {});
  keepTempoPhase();
  play = null;
}

// プレイ中に補正した拍の位置を、次の人にも引き継ぐ
function keepTempoPhase() {
  if (play && play.mode === 'karaoke' && tempo.anchorT !== null) tempo.anchorT += play.origin - play.origin0;
}

function rankLetter(score) {
  return score >= 950000 ? 'SS' : score >= 900000 ? 'S' : score >= 800000 ? 'A' : score >= 650000 ? 'B' : score >= 500000 ? 'C' : 'D';
}

function rankDeco(letter) {
  if (letter === 'SS' || letter === 'S') return { crown: true, glasses: true, sparkle: true };
  if (letter === 'A') return { glasses: true };
  if (letter === 'C' || letter === 'D') return { tears: true };
  return {};
}

function finishTurn(early) {
  if (!play || play.done) return;
  play.done = true;
  const score = scoreOf(early || play.endless ? partialTotal() : play.notes.length);
  const r = {
    id: play.player.id, score, letter: rankLetter(score),
    counts: play.counts, maxCombo: play.maxCombo,
    avgOffset: play.offN ? Math.round(1000 * play.offSum / play.offN) : null,
  };
  session.results.push(r);
  const wasKaraoke = play.mode === 'karaoke';
  abortPlay();
  showResult(r, wasKaraoke);
}

let resultTimer = null;

function showResult(r, wasKaraoke) {
  const p = playerById(r.id);
  setAvatar($('result-avatar'), r.id, 130, rankDeco(r.letter));
  $('result-avatar').className = 'pop';
  $('result-name').textContent = p ? p.name : '';
  $('st-perfect').textContent = r.counts.perfect;
  $('st-great').textContent = r.counts.great;
  $('st-good').textContent = r.counts.good;
  $('st-miss').textContent = r.counts.miss;
  $('st-combo').textContent = r.maxCombo;
  $('st-offset').textContent = r.avgOffset === null || wasKaraoke ? '-'
    : `${r.avgOffset > 0 ? '+' : ''}${r.avgOffset}ms ${Math.abs(r.avgOffset) < 25 ? '' : r.avgOffset > 0 ? '(おそめ)' : '(はやめ)'}`;
  $('result-rank').textContent = '';
  $('btn-result-next').textContent = session.idx + 1 < session.order.length ? 'つぎの人へ' : '結果発表へ！';
  showScreen('result');

  // スコアのカウントアップ → ランク表示
  const t0 = perfNow();
  cancelAnimationFrame(resultTimer);
  const step = () => {
    const k = clamp((perfNow() - t0) / 1.1, 0, 1);
    $('result-score').textContent = Math.round(r.score * (1 - Math.pow(1 - k, 3))).toLocaleString();
    if (k < 1) { resultTimer = requestAnimationFrame(step); return; }
    $('result-rank').textContent = r.letter;
    $('result-rank').className = 'rank-letter pop';
    sfx.rank();
  };
  step();
}

// ----- 結果発表 -----
let revealTimers = [];

function showRanking() {
  const ranked = session.results.slice().sort((a, b) => b.score - a.score);
  const n = ranked.length;
  const podium = $('podium'), list = $('rank-list');
  podium.textContent = '';
  list.textContent = '';
  list.style.visibility = 'hidden';

  const cols = {};
  [[1, 'p2'], [0, 'p1'], [2, 'p3']].forEach(([i, cls]) => {
    const r = ranked[i];
    if (!r) return;
    const p = playerById(r.id);
    const col = document.createElement('div');
    col.className = 'col ' + cls;
    col.appendChild(avatarCanvas(r.id, i === 0 ? 92 : 70, i === 0 ? { crown: true, sparkle: true } : {}));
    const nm = document.createElement('div'); nm.className = 'pname'; nm.textContent = p ? p.name : '';
    const sc = document.createElement('div'); sc.className = 'pscore'; sc.textContent = r.score.toLocaleString();
    const bl = document.createElement('div'); bl.className = 'block'; bl.textContent = String(i + 1);
    col.append(nm, sc, bl);
    podium.appendChild(col);
    cols[i] = col;
  });

  ranked.forEach((r, i) => {
    const p = playerById(r.id);
    const item = document.createElement('div');
    item.className = 'rank-item';
    const no = document.createElement('div'); no.className = 'no'; no.textContent = String(i + 1);
    const av = avatarCanvas(r.id, 34, n >= 3 && i === n - 1 ? { tears: true } : i === 0 ? { crown: true } : {});
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = p ? p.name : '';
    const sc = document.createElement('div'); sc.className = 'sc'; sc.textContent = r.score.toLocaleString();
    const lt = document.createElement('div'); lt.className = 'lt'; lt.textContent = r.letter;
    item.append(no, av, nm, sc, lt);
    list.appendChild(item);
  });

  showScreen('ranking');
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  const at = (sec, fn) => revealTimers.push(setTimeout(fn, sec * 1000));
  const order = [2, 1, 0].filter((i) => cols[i]);   // 3位 → 2位 → 1位 の順に発表
  const firstAt = 0.9 + (order.length - 1) * 1.3;
  sfx.drumroll(firstAt);
  order.forEach((i, k) => at(0.9 + k * 1.3, () => {
    cols[i].classList.add('show');
    if (i === 0) { sfx.fanfare(); startConfetti(); } else sfx.reveal();
  }));
  at(firstAt + 0.9, () => { list.style.visibility = 'visible'; });
}

// ---------------------------------------------------------------
// 描画
// ---------------------------------------------------------------
const stage = $('stage');
const ctx = stage.getContext('2d');
const view = { w: 0, h: 0, dpr: 1, safeTop: 0, safeBottom: 0 };
const FONT = '"Hiragino Maru Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif';

// env(safe-area-inset-*) は JS から直接読めないので、見えない要素の padding 経由で取得する
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
$('app').appendChild(safeProbe);

function resize() {
  const r = $('app').getBoundingClientRect();
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = r.width; view.h = r.height;
  stage.width = Math.round(view.w * view.dpr);
  stage.height = Math.round(view.h * view.dpr);
  const cs = getComputedStyle(safeProbe);
  view.safeTop = parseFloat(cs.paddingTop) || 0;
  view.safeBottom = parseFloat(cs.paddingBottom) || 0;
}

function drawBackground(now, beatPhase, fever) {
  const { w, h } = view;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, fever ? '#3a1260' : '#1d1040');
  g.addColorStop(1, fever ? '#160a35' : '#0b0620');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // ゆっくり動くスポットライト
  const pulse = 1 - beatPhase;
  const lights = [['255,79,163', 0.0], ['63,224,255', 2.1], ['255,216,77', 4.2]];
  lights.forEach(([rgb, ph], i) => {
    const x = w * (0.5 + 0.45 * Math.sin(now * (0.23 + i * 0.07) + ph));
    const y = h * (0.3 + 0.22 * Math.cos(now * (0.19 + i * 0.05) + ph));
    const r = Math.max(w, h) * (0.42 + 0.05 * pulse);
    const a = (fever ? 0.3 : 0.17) + 0.08 * pulse;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${rgb},${a})`);
    rg.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  });
}

function reaction() {
  return {
    glasses: play.combo >= 10,
    crown: play.combo >= 25,
    sparkle: play.combo >= 25,
    rainbow: play.combo >= 50,
    tears: play.missStreak >= 3,
  };
}

function drawPlay(now) {
  const { w, h } = view;
  const t = songTime();
  const laneW = w / LANES;
  const r = Math.min(laneW * 0.4, 46);
  const hudTop = view.safeTop + 8;
  const judgeY = h - view.safeBottom - Math.max(110, h * 0.17);
  const beat = t / play.spb;
  const beatPhase = beat - Math.floor(beat);
  const fever = isFeverAt(beat);

  // レーン
  for (let i = 0; i < LANES; i++) {
    const x = i * laneW;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.015)';
    ctx.fillRect(x, 0, laneW, h);
    const fl = 1 - (now - play.laneFlash[i]) / 0.2;
    if (fl > 0) {
      const lg = ctx.createLinearGradient(0, judgeY, 0, judgeY - 260);
      lg.addColorStop(0, LANE_COLOR[i] + 'aa');
      lg.addColorStop(1, LANE_COLOR[i] + '00');
      ctx.globalAlpha = fl;
      ctx.fillStyle = lg;
      ctx.fillRect(x, judgeY - 260, laneW, 260 + (h - judgeY));
      ctx.globalAlpha = 1;
    }
  }

  // コンボ (ノーツの後ろにうっすら)
  if (play.combo >= 3) {
    const k = clamp((now - play.comboAt) / 0.15, 0, 1);
    ctx.save();
    ctx.translate(w / 2, h * 0.36);
    ctx.scale(1.25 - 0.25 * k, 1.25 - 0.25 * k);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `900 72px ${FONT}`;
    ctx.fillText(String(play.combo), 0, 0);
    ctx.font = `bold 18px ${FONT}`;
    ctx.fillText('COMBO', 0, 26);
    ctx.restore();
  }

  // 判定ラインとターゲット
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, judgeY); ctx.lineTo(w, judgeY); ctx.stroke();
  for (let i = 0; i < LANES; i++) {
    const cx = (i + 0.5) * laneW;
    ctx.strokeStyle = LANE_COLOR[i];
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.6 + 0.4 * (1 - beatPhase);
    ctx.beginPath(); ctx.arc(cx, judgeY, r + 5 + 3 * Math.pow(1 - beatPhase, 2), 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ノーツ (奥のものから描く)
  const startY = -r;
  const visible = [];
  for (let i = play.head; i < play.notes.length; i++) {
    const n = play.notes[i];
    if (n.time - t > play.approach) break;
    if (!n.judged) visible.push(n);
  }
  for (let i = visible.length - 1; i >= 0; i--) {
    const n = visible[i];
    const k = 1 - (n.time - t) / play.approach;
    const y = startY + (judgeY - startY) * k;
    const cx = (n.lane + 0.5) * laneW;
    const sp = sprites.get(n.face);
    if (sp) ctx.drawImage(sp.color, cx - r, y - r, r * 2, r * 2);
    ctx.strokeStyle = n.fever ? '#ffe9a0' : LANE_COLOR[n.lane];
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, y, r, 0, TAU); ctx.stroke();
  }

  // ヒット・ミスのエフェクト
  for (const f of play.fx) {
    const age = now - f.at;
    const cx = (f.lane + 0.5) * laneW;
    const sp = sprites.get(f.face);
    if (f.type === 'hit') {
      const k = clamp(age / 0.32, 0, 1);
      ctx.globalAlpha = 1 - k;
      if (sp) {
        const rr = r * (1 + 0.7 * k);
        ctx.drawImage(sp.color, cx - rr, judgeY - rr - 30 * k, rr * 2, rr * 2);
      }
      ctx.strokeStyle = JUDGE_COLOR[f.judge];
      ctx.lineWidth = 5 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(cx, judgeY, r + 10 + 50 * k, 0, TAU); ctx.stroke();
      ctx.fillStyle = JUDGE_COLOR[f.judge];
      for (let j = 0; j < 8; j++) {
        const a = j / 8 * TAU + f.at;
        const d = r + 90 * k;
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, judgeY + Math.sin(a) * d, 4 * (1 - k) + 1, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      const k = clamp(age / 0.5, 0, 1);
      ctx.globalAlpha = 0.8 * (1 - k);
      if (sp) ctx.drawImage(sp.gray, cx - r, judgeY + r * 0.6 + 70 * k - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }
  }

  // 判定の文字
  if (play.judgeFx && now - play.judgeFx.at < 0.45) {
    const k = (now - play.judgeFx.at) / 0.45;
    ctx.save();
    ctx.translate(w / 2, judgeY - r - 56 - 12 * k);
    const s = 1.3 - 0.3 * clamp(k * 4, 0, 1);
    ctx.scale(s, s);
    ctx.globalAlpha = 1 - Math.pow(k, 3);
    ctx.textAlign = 'center';
    ctx.font = `900 34px ${FONT}`;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(JUDGE_LABEL[play.judgeFx.judge], 0, 0);
    ctx.fillStyle = JUDGE_COLOR[play.judgeFx.judge];
    ctx.fillText(JUDGE_LABEL[play.judgeFx.judge], 0, 0);
    ctx.restore();
  }

  // HUD
  const hg = ctx.createLinearGradient(0, 0, 0, hudTop + 110);
  hg.addColorStop(0, 'rgba(10,4,28,0.92)');
  hg.addColorStop(1, 'rgba(10,4,28,0)');
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, w, hudTop + 110);

  if (!play.endless) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, view.safeTop, w, 4);
    ctx.fillStyle = '#ff4fa3';
    ctx.fillRect(0, view.safeTop, w * clamp(t / play.duration, 0, 1), 4);
  }

  const bounce = Math.max(0, 1 - (now - play.hitAt) / 0.15);
  drawAvatar(ctx, play.player.id, 50, hudTop + 56, 32 + 4 * bounce, reaction(), now);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = `bold 16px ${FONT}`;
  ctx.fillText(play.player.name, 96, hudTop + 40);
  ctx.font = `900 28px ${FONT}`;
  ctx.fillText(liveScore().toLocaleString(), 96, hudTop + 72);
  if (play.endless) {
    const sec = Math.max(0, Math.floor(t));
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = '#c3b8ea';
    ctx.fillText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}  終了は右上の II から`, 96, hudTop + 92);
  }

  // はじまる前のカウント
  if (beat < play.leadBeats) {
    const left = play.leadBeats - Math.floor(beat);   // 4,3,2,1 → "3","2","1","GO!"
    let text = play.mode === 'karaoke' ? '曲に合わせてタップ！' : 'READY…';
    let big = false;
    if (beat >= 0 && left <= 4) { text = left === 1 ? 'GO!' : String(left - 1); big = true; }
    ctx.save();
    ctx.translate(w / 2, h * 0.45);
    const s = big ? 1 + 0.35 * Math.pow(1 - beatPhase, 2) : 1;
    ctx.scale(s, s);
    ctx.textAlign = 'center';
    ctx.font = `900 ${big ? 96 : 30}px ${FONT}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = '#ffd84d';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // バナー (サビ・コンボ)
  if (play.banner && now - play.banner.at < 1.6) {
    const k = (now - play.banner.at) / 1.6;
    const x = w / 2 + (k < 0.15 ? (1 - k / 0.15) * w : k > 0.85 ? -((k - 0.85) / 0.15) * w : 0);
    ctx.save();
    ctx.translate(x, h * 0.24);
    ctx.rotate(-0.05);
    ctx.fillStyle = 'rgba(255,79,163,0.92)';
    ctx.fillRect(-w, -28, w * 2, 56);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `900 28px ${FONT}`;
    ctx.fillText(play.banner.text, 0, 10);
    ctx.restore();
  }

  return { beatPhase, fever };
}

// ----- 紙吹雪 -----
let confetti = [];
let confettiOn = false;

function startConfetti() {
  confettiOn = true;
  confetti = [];
  for (let i = 0; i < 120; i++) confetti.push(newConfetto(true));
}

function stopConfetti() { confettiOn = false; confetti = []; }

function newConfetto(anywhere) {
  return {
    x: Math.random() * view.w, y: anywhere ? Math.random() * -view.h : -20,
    vx: (Math.random() - 0.5) * 60, vy: 90 + Math.random() * 140,
    rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8,
    w: 6 + Math.random() * 7, col: LANE_COLOR[Math.floor(Math.random() * 4)],
  };
}

function drawConfetti(dt) {
  confetti.forEach((c, i) => {
    c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
    if (c.y > view.h + 20) confetti[i] = newConfetto(false);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.fillStyle = c.col;
    ctx.fillRect(-c.w / 2, -c.w / 4, c.w, c.w / 2);
    ctx.restore();
  });
}

// ----- メインループ -----
let lastFrame = perfNow();

function frame() {
  const now = perfNow();
  const dt = Math.min(0.05, now - lastFrame);
  lastFrame = now;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  const inPlay = play && (ui.screen === 'play' || ui.screen === 'pause');
  if (inPlay) {
    if (!play.paused) updatePlay();
  }
  if (play && inPlay) {
    const beat = songTime() / play.spb;
    drawBackground(now, beat - Math.floor(beat), isFeverAt(beat));
    drawPlay(now);
  } else {
    const ph = ui.screen === 'tempo' ? tempoPhase(now) : null;
    drawBackground(now, ph === null ? (now * 1.6) % 1 : ph, ui.screen === 'ranking');
  }
  if (confettiOn) drawConfetti(dt);
  if (ui.screen === 'tempo') updateTapPad(now);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------
// 入力とボタン
// ---------------------------------------------------------------
function bindAll() {
  const on = (id, fn) => $(id).addEventListener('click', () => { sfx.click(); fn(); });

  on('btn-start', () => { renderPlayers(); showScreen('players'); });
  on('btn-add', () => openEdit(null));
  on('btn-players-back', showTitle);
  on('btn-players-next', () => {
    if (!activePlayers().length) { toast('参加するメンバーを1人以上えらんでね'); return; }
    refreshSetup();
    showScreen('setup');
  });
  on('btn-setup-back', () => { renderPlayers(); showScreen('players'); });
  on('btn-setup-next', beginSession);

  // メンバー編集
  const pickPhoto = () => $('file').click();
  on('btn-photo', pickPhoto);
  on('edit-avatar', pickPhoto);
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    openCropper(f).then((url) => {
      if (url && editing) { editing.photo = url; refreshEditAvatar(); }
    });
  });
  $('edit-name').addEventListener('input', () => { if (editing && !editing.photo) refreshEditAvatar(); });
  on('btn-edit-save', saveEdit);
  on('btn-edit-cancel', () => $('modal-edit').classList.remove('on'));
  on('btn-edit-delete', deleteEdit);
  bindCropper();

  // つぎの人 / テンポ
  on('btn-go', () => {
    if (state.settings.mode === 'karaoke' && !tempo.ready) openTempo();
    else startTurn();
  });
  on('btn-retempo', openTempo);
  on('btn-next-quit', () => { session = null; showTitle(); });
  $('tap-pad').addEventListener('pointerdown', (e) => { e.preventDefault(); initAudio(); tempoTap(); });
  on('bpm-minus', () => setBpm(tempo.bpm - 1));
  on('bpm-plus', () => setBpm(tempo.bpm + 1));
  on('bpm-half', () => setBpm(tempo.bpm / 2));
  on('bpm-double', () => setBpm(tempo.bpm * 2));
  $('bpm-input').addEventListener('change', (e) => setBpm(Number(e.target.value) || tempo.bpm));
  $('chk-round').addEventListener('change', (e) => {
    state.settings.roundBpm = e.target.checked;
    saveState();
    if (e.target.checked) setBpm(Math.round(tempo.bpm));
  });
  on('btn-tempo-reset', () => { tempo.taps = []; tempo.anchorT = null; $('tempo-hint').textContent = 'もう一度、曲のビートに合わせてタップしてね'; });
  on('btn-tempo-back', showNext);
  on('btn-tempo-go', () => { tempo.ready = true; startTurn(); });

  // ポーズ
  $('btn-pause').addEventListener('click', pauseGame);
  on('btn-resume', resumeGame);
  on('btn-retry', () => { abortPlay(); startTurn(); });
  on('btn-finish', () => {
    holdSuspend = false;
    finishTurn(true);
  });
  on('btn-quit', () => { abortPlay(); session = null; showTitle(); });

  // 結果
  on('btn-result-next', () => {
    cancelAnimationFrame(resultTimer);
    session.idx++;
    if (session.idx < session.order.length) showNext();
    else showRanking();
  });
  on('btn-rank-again', () => { revealTimers.forEach(clearTimeout); beginSession(); });
  on('btn-rank-title', () => { revealTimers.forEach(clearTimeout); session = null; showTitle(); });

  // レーンのタップ (マルチタッチ対応)
  stage.addEventListener('pointerdown', (e) => {
    if (ui.screen !== 'play') return;
    e.preventDefault();
    initAudio();
    const rect = stage.getBoundingClientRect();
    tapLane(clamp(Math.floor((e.clientX - rect.left) / (rect.width / LANES)), 0, LANES - 1));
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // パソコンでは D F J K キーでも遊べる
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (ui.screen === 'play') {
      if (e.code in KEY_LANE) { initAudio(); tapLane(KEY_LANE[e.code]); }
      else if (e.code === 'Escape' || e.code === 'Space') { e.preventDefault(); pauseGame(); }
    } else if (ui.screen === 'tempo' && e.code === 'Space' && document.activeElement !== $('bpm-input')) {
      e.preventDefault();
      initAudio();
      tempoTap();
    }
  });

  window.addEventListener('touchend', initAudio, { passive: true });
  window.addEventListener('pointerup', initAudio);
  window.addEventListener('click', initAudio);
  // ピンチやダブルタップでのズームを防ぐ
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
  window.addEventListener('orientationchange', () => setTimeout(resize, 300));
  window.addEventListener('resize', resize);
}

// ---------------------------------------------------------------
// 起動
// ---------------------------------------------------------------
loadState();
resize();
bindSetup();
bindAll();
Promise.all(state.players.map(buildSprite)).then(showTitle);
requestAnimationFrame(frame);
