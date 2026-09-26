'use strict';
// ===============================================================
// 顔ノーツ☆カラオケバトル
//   仲間の顔写真がノーツになって流れてくるリズムゲーム。
//   スマホ1台を回して順番にプレイし、最後に顔写真つきで結果発表する。
//   写真は localStorage (この端末の中) にだけ保存し、外部には送信しない。
// ===============================================================

const VERSION = '2026-09-26e';

// URL の ?g=... で「別のグループ」を作れる。
// 保存するデータもスプレッドシートのメンバーも、グループごとに分かれる
const GROUP = (function () {
  try {
    const g = new URLSearchParams(location.search).get('g') || '';
    return g.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  } catch (e) { return ''; }
})();

// LINE などアプリの中のブラウザは、Safari とは別のキャッシュを持っている。
// 古いまま動いていることがあるので、その可能性を伝えられるようにする
function inAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Line\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV|Instagram/i.test(ua)) return 'SNSアプリ';
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari/.test(ua)) return 'アプリ内';
  return '';
}
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const perfNow = () => performance.now() / 1000;

const LANES = 4;
const WINDOW = { perfect: 0.055, great: 0.105, good: 0.16 };   // 判定幅 (秒)
const WEIGHT = { perfect: 1, great: 0.75, good: 0.4, miss: 0 };
const APPROACH = { easy: 1.7, normal: 1.45, hard: 1.2 };        // ノーツが見えてから判定ラインまでの秒数
const JUDGE_LABEL = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS', trap: 'ダメ！' };
const JUDGE_COLOR = { perfect: '#ffd84d', great: '#7dffb0', good: '#3fe0ff', miss: '#9d94bd', trap: '#ff3b3b' };

// 叩いてはいけない「他メンバーの顔」のノーツ
const TRAP_COLOR = '#ff3b3b';
const TRAP_GAP = 0.4;        // 前後にこれだけ間を空けて、避ける余裕を作る
const TRAP_MIN = 8;          // 何秒おきに出すか (最短)
const TRAP_MAX = 12;         // 同 (最長)
const TRAP_PENALTY = 15000;  // 叩いてしまったときの減点
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
const STORE_KEY = 'krg.v1' + (GROUP ? '.' + GROUP : '');
const state = {
  players: [],   // { id, name, photo (dataURL | null), color, active }
  settings: { mode: 'track', song: 0, diff: 'normal', length: 90, sfx: true, shuffle: false, offset: 0, roundBpm: true, songPick: 'same' },
  recent: [],    // さいきん使った曲 { id, name, artist, art, url }
  cloud: { endpoint: '', me: '', room: '', round: null, isHost: false, retry: null },   // 集計用のURL・この端末の持ち主・いまのお題・未送信のスコア
};

function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.players)) state.players = d.players;
    if (d && d.settings) Object.assign(state.settings, d.settings);
    if (d && Array.isArray(d.recent)) state.recent = d.recent;
    if (d && d.cloud) Object.assign(state.cloud, d.cloud);
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
  trap() {
    if (!this.ok()) return;
    const t = actx.currentTime;
    toneHit(t, master, { type: 'square', f1: 220, f2: 90, dur: 0.3, vol: 0.18 });
    noiseHit(t, master, { type: 'lowpass', freq: 900, vol: 0.18, dur: 0.25 });
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
// 曲さがし (Apple の試聴用30秒音源)
//   えらんだ曲をその場で解析して、テンポと譜面を作る。
//   音源はメモリ上だけで扱い、端末にもリポジトリにも保存しない。
// ---------------------------------------------------------------
const track = {
  current: null,    // えらんだ曲
  data: null,       // { buffer, analysis }
  source: null,     // 再生中の音源
  cache: new Map(), // url -> { buffer, analysis }
  onPicked: null,   // えらび終わったあとにすること
  busy: false,
};

// Safari など、直接読み取れない環境のための予備の取り方。
// Apple の検索APIが用意している callback を使うので、CORS を通らずに済む
function jsonp(url, ms) {
  return new Promise((resolve, reject) => {
    const cb = '__it' + Math.random().toString(36).slice(2, 10);
    const el = document.createElement('script');
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      el.remove();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('時間切れ')), ms || 12000);
    window[cb] = (data) => finish(resolve, data);
    el.onerror = () => finish(reject, new Error('つながりません'));
    el.src = url + '&callback=' + cb;
    document.head.appendChild(el);
  });
}

const SEARCH_URL = 'https://itunes.apple.com/search?media=music&entity=song&limit=20&country=JP&term=';

const toTrack = (x) => ({
  id: String(x.trackId),
  name: x.trackName,
  artist: x.artistName,
  art: x.artworkUrl100 || '',
  url: x.previewUrl,
});

// 集計用のURL経由で取り寄せる。Apple に直接つながらない環境のための逃げ道
async function searchViaCloud(term) {
  const base = state.cloud.endpoint;
  const r = await fetch(base + (base.includes('?') ? '&' : '?')
    + 'q=' + encodeURIComponent(term) + '&t=' + Date.now());
  if (!r.ok) throw new Error('status ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error');
  return j.results || [];
}

// 直接 → JSONP → 中継 の順に試す
async function searchTracks(term) {
  const url = SEARCH_URL + encodeURIComponent(term);
  const why = [];
  const note = (label, e) => why.push(label + '=' + ((e && e.message) || e));

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    return (j.results || []).filter((x) => x.previewUrl).map(toTrack);
  } catch (e) { note('直接', e); }

  try {
    const j = await jsonp(url);
    return ((j && j.results) || []).filter((x) => x.previewUrl).map(toTrack);
  } catch (e) { note('JSONP', e); }

  if (cloudUrlOk(state.cloud.endpoint)) {
    try {
      return (await searchViaCloud(term)).map(toTrack);
    } catch (e) {
      // Google の権限エラーは長いので、やることだけ伝える
      const m = (e && e.message) || '';
      if (/UrlFetchApp|external_request/.test(m)) {
        why.push('中継=Apps Script で authorize を1回実行して、外部サイトへの接続を許可してね');
      } else note('中継', e);
    }
  } else {
    why.push('中継=集計用のURLが未設定');
  }
  throw new Error(why.join(' / '));
}

// 解析した曲は 30秒でも 10MB 以上あるので、ためこみすぎるとスマホが苦しくなる
const TRACK_CACHE_MAX = 3;

// 音源を読み込んで解析する。同じ曲の2回目はすぐ返る
async function prepareTrack(t, onStep) {
  const hit = track.cache.get(t.url);
  if (hit) return hit;
  initAudio();
  if (!actx) throw new Error('この端末では音を鳴らせません');
  // 着信やアプリ切り替えのあとは止まっていることがある
  if (actx.state !== 'running') {
    try { await actx.resume(); } catch (e) { /* 鳴らせなくても解析はできる */ }
  }

  if (onStep) onStep('曲を読み込み中…');
  let r;
  try {
    r = await fetch(t.url);
  } catch (e) {
    throw new Error('曲をダウンロードできませんでした（通信を確かめてね）');
  }
  if (!r.ok) throw new Error('曲をダウンロードできませんでした（' + r.status + '）');
  const bytes = await r.arrayBuffer();

  if (onStep) onStep('曲を聴いています…');
  let buffer;
  try {
    buffer = await actx.decodeAudioData(bytes);
  } catch (e) {
    throw new Error('この曲の音を読み取れませんでした');
  }

  if (onStep) onStep('譜面を作っています…');
  // 表示を先に更新してから、重い解析に入る
  await new Promise((res) => setTimeout(res, 30));
  let analysis;
  try {
    analysis = Beat.analyze(buffer);
  } catch (e) {
    throw new Error('譜面を作れませんでした');
  }
  if (!analysis) throw new Error('この曲はテンポを読み取れませんでした');

  const data = { buffer, analysis };
  // 古いものから捨てる
  while (track.cache.size >= TRACK_CACHE_MAX) {
    track.cache.delete(track.cache.keys().next().value);
  }
  track.cache.set(t.url, data);
  return data;
}

function rememberTrack(t) {
  state.recent = [t].concat(state.recent.filter((x) => x.url !== t.url)).slice(0, 12);
  saveState();
}

function trackStop() {
  if (track.source) {
    try { track.source.stop(); } catch (e) { /* もう止まっている */ }
    try { track.source.disconnect(); } catch (e) { /* 同上 */ }
    track.source = null;
  }
}

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
  if (name !== 'ranking') stopConfetti();   // 紙吹雪は結果発表の画面だけ
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
  // 古い index.html が残っている端末でも落ちないようにする
  const v = $('ver');
  if (v) v.textContent = 'ver ' + VERSION;
  const row = $('title-faces');
  row.textContent = '';
  state.players.slice(0, 8).forEach((p) => row.appendChild(avatarCanvas(p.id, 44)));
  showScreen('title');
}

// 幹事が配ったメンバーを、この端末に取り込む。
// 同じ名前の人がいれば増やさない (何度取り込んでも大丈夫)
function importMembers(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const added = [];
  list.slice(0, 30).forEach((m, i) => {
    const name = String((m && m.name) || '').slice(0, 8);
    if (!name) return;
    const photo = typeof m.avatar === 'string' && /^data:image\//.test(m.avatar) ? m.avatar
      : typeof m.photo === 'string' && /^data:image\//.test(m.photo) ? m.photo : null;
    const same = state.players.find((p) => p.name === name);
    if (same) {
      // 名前が同じ人は増やさない。写真は差し替えるが、
      // 本人が自分で選んだ写真だけは上書きしない
      const mayReplace = !same.photo || same.photoFrom !== 'self';
      if (photo && photo !== same.photo && mayReplace) {
        same.photo = photo;
        same.photoFrom = 'import';
        added.push(same);
      }
      return;
    }
    const p = {
      id: 'p' + Date.now().toString(36) + i.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      name, photo, photoFrom: photo ? 'import' : '',
      color: AVATAR_COLORS[state.players.length % AVATAR_COLORS.length], active: true,
    };
    state.players.push(p);
    added.push(p);
  });
  if (!added.length) return [];
  if (!saveState()) toast('保存容量がいっぱいです。今回だけ使えます');
  return added;
}

// 幹事の端末のメンバーを、スプレッドシートにアップロードして全員に配る
async function shareMembers() {
  const list = state.players.map((p) => ({ memberId: p.id, name: p.name, avatar: avatarData(p.id) }));
  if (!list.length) { toast('先にメンバーを登録してね'); return; }
  $('round-status').textContent = 'メンバーを配っています…';
  try {
    await cloudPost({ type: 'members', list });
    const j = await cloudGet(cloud.room);
    const n = (j.members || []).length;
    $('round-status').textContent = n
      ? `${n}人のメンバーを配りました。お題リンクを開いた人に自動で入ります`
      : '配れませんでした。もう一度ためしてね';
  } catch (e) {
    $('round-status').textContent = 'メンバーを配れませんでした。通信を確かめてね';
  }
}

// ----- あなたは誰？ -----
function openWho() {
  const box = $('who-list');
  box.textContent = '';
  for (const p of state.players) {
    const row = document.createElement('button');
    row.className = 'player p-main';
    row.style.width = '100%';
    row.appendChild(avatarCanvas(p.id, 44));
    const t = document.createElement('div');
    t.style.minWidth = '0';
    const nm = document.createElement('div');
    nm.className = 'p-name';
    nm.textContent = p.name;
    t.appendChild(nm);
    row.appendChild(t);
    row.addEventListener('click', () => {
      state.cloud.me = p.id;
      saveState();
      $('modal-who').classList.remove('on');
      renderRound();
    });
    box.appendChild(row);
  }
  $('modal-who').classList.add('on');
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
let afterEdit = null;   // 保存したあとにすること

function openEdit(p) {
  editing = p
    ? { id: p.id, name: p.name, photo: p.photo, photo0: p.photo, color: p.color }
    : { id: null, name: '', photo: null, photo0: null, color: AVATAR_COLORS[state.players.length % AVATAR_COLORS.length] };
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
  // 自分で写真を選び直した人は、配布でも上書きしない
  if (editing.photo !== editing.photo0) p.photoFrom = editing.photo ? 'self' : '';
  $('modal-edit').classList.remove('on');
  if (!saveState()) toast('保存容量がいっぱいです。この写真は今回だけ使えます');
  buildSprite(p).then(() => {
    renderPlayers();
    if (afterEdit) { const f = afterEdit; afterEdit = null; f(p); }
  });
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
let refreshRoundDiff = () => {};

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
    const m = s.mode;
    $('panel-song').style.display = m === 'builtin' ? 'block' : 'none';
    $('panel-pick').style.display = m === 'track' ? 'block' : 'none';
    $('panel-length').style.display = m === 'karaoke' ? 'block' : 'none';
    $('offset-box').style.display = m === 'karaoke' ? 'none' : 'block';
    $('mode-hint').textContent = m === 'track'
      ? '好きな曲を検索して、その30秒の試聴音源で遊びます。テンポも譜面も自動で作られます。（通信が必要です）'
      : m === 'karaoke'
        ? 'カラオケ機で曲を流し、そのビートをタップしてテンポを測ります。歌う人の横で、タンバリン係として遊べます。'
        : 'ゲームが演奏するオリジナル曲で遊びます。1人あたり約1分。';
  };
  const segs = [
    bindSeg('seg-mode', () => s.mode, (v) => { s.mode = v; panels(); }),
    bindSeg('seg-song', () => s.song, (v) => { s.song = Number(v); }),
    bindSeg('seg-length', () => s.length, (v) => { s.length = Number(v); }),
    bindSeg('seg-diff', () => s.diff, (v) => { s.diff = v; }),
    bindSeg('seg-pick', () => s.songPick, (v) => { s.songPick = v; }),
  ];
  $('chk-shuffle').addEventListener('change', (e) => { s.shuffle = e.target.checked; saveState(); });
  $('chk-sfx').addEventListener('change', (e) => { s.sfx = e.target.checked; saveState(); });
  $('rng-offset').addEventListener('input', (e) => {
    s.offset = Number(e.target.value);
    $('offset-val').textContent = (s.offset > 0 ? '+' : '') + s.offset;
    saveState();
  });
  refreshRoundDiff = bindSeg('seg-rdiff', () => s.diff, (v) => { s.diff = v; refreshSetup(); });
  refreshSetup = () => {
    refreshRoundDiff();
    segs.forEach((f) => f());
    panels();
    $('chk-shuffle').checked = s.shuffle;
    $('chk-sfx').checked = s.sfx;
    $('rng-offset').value = s.offset;
    $('offset-val').textContent = (s.offset > 0 ? '+' : '') + s.offset;
  };
  refreshSetup();
}


// ---------------------------------------------------------------
// つながりを調べる
//   どこまで届いてどこで止まっているかを、その場で確かめられるようにする
// ---------------------------------------------------------------
const SEARCH_BASE = SEARCH_URL.replace('limit=20', 'limit=1');

async function netCheck() {
  const box = $('net-result');
  const lines = [];
  const show = () => { box.textContent = lines.join('\n'); box.classList.add('on'); };
  const step = async (name, fn) => {
    lines.push('… ' + name);
    show();
    const t0 = Date.now();
    try {
      const r = await fn();
      lines[lines.length - 1] = '○ ' + name + (r ? '  ' + r : '') + '  ' + (Date.now() - t0) + 'ms';
    } catch (e) {
      lines[lines.length - 1] = '× ' + name + '  ' + ((e && e.message) || e);
    }
    show();
    return lines[lines.length - 1][0] === '○';
  };

  const ua = navigator.userAgent || '';
  lines.push('ver ' + VERSION);
  lines.push('ブラウザ ' + (inAppBrowser() || 'ふつう'));
  lines.push('オンライン ' + (navigator.onLine ? 'はい' : 'いいえ'));
  lines.push(ua.slice(-70));
  lines.push('');
  show();

  let found = null;
  await step('検索API（直接）', async () => {
    const r = await fetch(SEARCH_BASE + encodeURIComponent('Lemon'));
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    found = found || (j.results || [])[0];
    return j.resultCount + '件';
  });
  await step('検索API（JSONP）', async () => {
    const j = await jsonp(SEARCH_BASE + encodeURIComponent('Lemon'), 10000);
    found = found || (j.results || [])[0];
    return j.resultCount + '件';
  });

  if (cloudUrlOk(state.cloud.endpoint)) {
    await step('検索API（中継）', async () => {
      const list = await searchViaCloud('Lemon');
      found = found || list[0];
      return list.length + '件';
    });
  }

  if (found && found.artworkUrl100) {
    await step('ジャケット画像', () => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth + 'px');
      img.onerror = () => rej(new Error('読み込めません'));
      img.src = found.artworkUrl100;
    }));
  }
  if (found && found.previewUrl) {
    await step('音源のダウンロード', async () => {
      const r = await fetch(found.previewUrl);
      if (!r.ok) throw new Error('status ' + r.status);
      const b = await r.arrayBuffer();
      return Math.round(b.byteLength / 1024) + 'KB';
    });
  } else {
    lines.push('（曲が見つからないので、音源の確認は省略）');
    show();
  }

  if (cloudUrlOk(state.cloud.endpoint)) {
    await step('集計用のURL', async () => {
      const r = await fetch(state.cloud.endpoint + '?room=&t=' + Date.now());
      if (!r.ok) throw new Error('status ' + r.status);
      await r.json();
      return 'OK';
    });
  }

  lines.push('');
  lines.push('この内容をそのまま送ってください');
  show();
}

// ----- 曲さがし画面 -----
function openSong(after, backTo) {
  $('btn-net-check').style.display = 'none';
  $('net-result').textContent = '';
  $('net-result').classList.remove('on');
  const note = $('song-note');
  if (note) {
    const app = inAppBrowser();
    note.textContent = '検索した言葉は Apple の検索サービスに送られます ・ ver ' + VERSION
      + (app ? ' ／ ' + app + 'の画面で開いています。うまく動かないときは Safari で開き直してね' : '');
  }
  track.onPicked = after;
  track.backTo = backTo || 'setup';
  $('song-status').textContent = '';
  $('song-q').value = '';   // 次の人が自分で検索しやすいように空にしておく
  renderSongList(state.recent, true);
  showScreen('song');
}

function renderSongList(list, isRecent) {
  const box = $('song-list');
  box.textContent = '';
  if (!list.length) {
    $('song-status').textContent = isRecent ? '曲名やアーティスト名で検索してね' : '見つかりませんでした';
    return;
  }
  $('song-status').textContent = isRecent ? 'さいきん使った曲' : '';
  for (const t of list) {
    const b = document.createElement('button');
    b.className = 'song-item';
    if (t.art) {
      const img = document.createElement('img');
      img.src = t.art;
      img.alt = '';
      b.appendChild(img);
    }
    const d = document.createElement('div');
    d.className = 't';
    const nm = document.createElement('b');
    nm.textContent = t.name;
    const ar = document.createElement('span');
    ar.textContent = t.artist;
    d.append(nm, ar);
    b.appendChild(d);
    b.addEventListener('click', () => pickTrack(t, b));
    box.appendChild(b);
  }
}

async function doSearch() {
  const q = $('song-q').value.trim();
  if (!q) { renderSongList(state.recent, true); return; }
  $('song-q').blur();
  $('song-status').textContent = 'さがしています…';
  $('song-list').textContent = '';
  try {
    renderSongList(await searchTracks(q), false);
  } catch (e) {
    $('song-status').textContent = '検索できませんでした。通信を確かめてね（'
      + (e && e.message ? e.message : e) + '）';
    $('btn-net-check').style.display = 'block';
  }
}

async function pickTrack(t, btn) {
  if (track.busy) return;
  track.busy = true;
  document.querySelectorAll('.song-item').forEach((el) => { el.disabled = true; });
  if (btn) btn.classList.add('on');
  initAudio();
  try {
    const data = await prepareTrack(t, (msg) => { $('song-status').textContent = msg; });
    track.current = t;
    track.data = data;
    rememberTrack(t);
    const after = track.onPicked;
    track.onPicked = null;
    track.busy = false;
    $('song-status').textContent = '';
    if (after) after();
  } catch (e) {
    track.busy = false;
    const app = inAppBrowser();
    $('song-status').textContent = (e && e.message ? e.message : 'この曲は読み込めませんでした')
      + (app ? ' / ' + app + 'の画面では読み込めないことがあります。Safari で開き直してみてね'
        : ' / ほかの曲でもためしてみてね');
    document.querySelectorAll('.song-item').forEach((el) => {
      el.disabled = false;
      el.classList.remove('on');
    });
  }
}

// ---------------------------------------------------------------
// みんなでランキング (Googleスプレッドシートに集計)
//   幹事が「お題」(曲とむずかしさ) を決めてリンクを配り、
//   各自が自分のスマホで別々に遊ぶと、スコアが集まって順位が出る。
// ---------------------------------------------------------------
const CLOUD_HOST = 'script.google.com';
const cloud = {
  room: '',       // お題のID
  round: null,    // { track, diff }
  entries: [],    // 取り寄せたスコア
  serverOld: false,   // スプレッドシート側のコードが古いとき
  loading: false,     // お題やランキングを取り寄せている最中か
  pending: null,  // 送信中の処理
  isHost: false,
};

// リンクに書かれたURLをそのまま信用しないための確認
function cloudUrlOk(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === CLOUD_HOST;
  } catch (e) { return false; }
}

function b64urlEnc(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDec(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Apps Script のURLは決まった形なので、真ん中のIDだけをリンクに入れる
const EXEC_HEAD = 'https://script.google.com/macros/s/';
const EXEC_TAIL = '/exec';

function endpointToId(u) {
  if (!u.startsWith(EXEC_HEAD) || !u.endsWith(EXEC_TAIL)) return null;
  const id = u.slice(EXEC_HEAD.length, -EXEC_TAIL.length);
  return /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : null;
}

function makeRoundLink() {
  // ?v=... のような目印は、配るリンクにも引き継ぐ。
  // これが落ちると、受け取った人が古いキャッシュのまま開いてしまう
  const base = location.origin + location.pathname + location.search;
  const id = endpointToId(state.cloud.endpoint);
  if (id) return `${base}#e=${id}&r=${cloud.room}`;
  // 見慣れない形のURLのときは、これまでどおりまるごと入れる
  const t = cloud.round.track;
  return base + '#p=' + b64urlEnc({
    e: state.cloud.endpoint, r: cloud.room, d: cloud.round.diff,
    t: { u: t.url, n: t.name, a: t.artist, c: t.art },
  });
}

// お題の中身はスプレッドシートから取り寄せるので、リンクにはIDだけが入る
function readRoundLink() {
  const h = location.hash || '';
  const m = /[#&]e=([A-Za-z0-9_-]{10,200})(?:&|$)/.exec(h);
  const r = /[#&]r=([A-Za-z0-9]{3,20})(?:&|$)/.exec(h);
  if (m && r) {
    const endpoint = EXEC_HEAD + m[1] + EXEC_TAIL;
    if (!cloudUrlOk(endpoint)) return null;
    return { endpoint, room: r[1], diff: null, track: null };
  }
  // 以前の形のリンク (お題の中身が入っているもの)
  const p = /[#&]p=([A-Za-z0-9_-]+)/.exec(h);
  if (!p) return null;
  try {
    const d = b64urlDec(p[1]);
    if (!d || !cloudUrlOk(d.e) || !d.r || !d.t || !d.t.u) return null;
    if (!/^https:\/\/[\w.-]*\.apple\.com\//.test(d.t.u)) return null;
    return {
      endpoint: d.e,
      room: String(d.r),
      diff: DIFF_LABEL[d.d] ? d.d : 'normal',
      track: {
        id: d.t.u, name: String(d.t.n || '曲'), artist: String(d.t.a || ''),
        art: /^https:\/\//.test(d.t.c || '') ? d.t.c : '', url: d.t.u,
      },
    };
  } catch (e) { return null; }
}

// スプレッドシートから受け取ったお題を、ゲームで使う形にする
function roundFromServer(r) {
  if (!r || !r.url || !/^https:\/\/[\w.-]*\.apple\.com\//.test(r.url)) return null;
  return {
    track: {
      id: r.url, name: String(r.song || '曲'), artist: String(r.artist || ''),
      art: /^https:\/\//.test(r.art || '') ? r.art : '', url: r.url,
    },
    diff: DIFF_LABEL[r.diff] ? r.diff : 'normal',
  };
}

const newRoomCode = () => {
  // 先頭を英字にしておく。'12e34' のような並びだと、
  // スプレッドシートが数値として読み替えてしまい、お題が見つからなくなるため
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  const head = letters[Math.floor(Math.random() * letters.length)];
  return head + (Math.random().toString(36) + '00000').slice(2, 7);
};

async function cloudGet(room) {
  const base = state.cloud.endpoint;
  const url = base + (base.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(room)
    + '&g=' + encodeURIComponent(GROUP) + '&t=' + Date.now();
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('GET ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'error');
  return j;
}

// 送信は返事を読まない形にしておき、そのあと取得して届いたか確かめる
async function cloudPost(payload) {
  await fetch(state.cloud.endpoint, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ group: GROUP }, payload)),
    redirect: 'follow',
  });
}

// ランキングに載せる小さめの顔写真を作る
function avatarData(id) {
  const sp = sprites.get(id);
  if (!sp) return '';
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = '#140a2e';
  x.fillRect(0, 0, 96, 96);
  x.drawImage(sp.color, 0, 0, 96, 96);
  return c.toDataURL('image/jpeg', 0.7);
}

const cloudSig = new Map();

function hashIdx(str, n) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

// ほかの人の顔を、ランキングに描けるように用意する
function buildCloudSprites(entries) {
  const jobs = [];
  for (const e of entries) {
    const id = 'c:' + e.playerId;
    const sig = (e.avatar || '').length + ':' + e.name;
    if (sprites.has(id) && cloudSig.get(id) === sig) continue;
    cloudSig.set(id, sig);
    jobs.push(buildSprite({
      id, name: e.name, photo: e.avatar || null,
      color: AVATAR_COLORS[hashIdx(e.playerId, AVATAR_COLORS.length)],
    }));
  }
  return Promise.all(jobs);
}

async function cloudSubmit(result) {
  const p = playerById(result.id);
  await cloudPost({
    type: 'score',
    room: cloud.room,
    playerId: result.id,
    name: p ? p.name : '',
    score: result.score,
    letter: result.letter,
    perfect: result.counts.perfect,
    great: result.counts.great,
    good: result.counts.good,
    miss: result.counts.miss,
    maxCombo: result.maxCombo,
    song: cloud.round ? cloud.round.track.name : '',
    diff: cloud.round ? cloud.round.diff : '',
    avatar: avatarData(result.id),
  });
  const j = await cloudGet(cloud.room);
  cloud.entries = j.entries || [];
  if (!cloud.entries.some((e) => e.playerId === result.id)) throw new Error('not saved');
  if (state.cloud.retry && state.cloud.retry.result.id === result.id) {
    state.cloud.retry = null;
    saveState();
  }
  await buildCloudSprites(cloud.entries);
  return cloud.entries;
}

// 送れなかったスコアがあれば、まず送り直す
async function cloudRetry() {
  const r = state.cloud.retry;
  if (!r || r.room !== cloud.room) return;
  await cloudSubmit(r.result);
  state.cloud.retry = null;
  saveState();
}

async function cloudRefresh() {
  cloud.loading = true;
  try {
    return await cloudRefreshInner();
  } finally {
    cloud.loading = false;
  }
}

async function cloudRefreshInner() {
  await cloudRetry();
  const j = await cloudGet(cloud.room);
  // 新しいコードなら round を必ず返す。無ければ古いまま動いている
  cloud.serverOld = !('round' in j);
  if (!cloud.round) {
    cloud.round = roundFromServer(j.round);
    if (cloud.round) rememberRound();
  } else if (cloud.isHost && !(j.round && j.round.url)) {
    await postRound();   // 登録できていなかったぶんを送り直す
  }
  cloud.entries = j.entries || [];
  const added = importMembers(j.members);
  if (added.length) await Promise.all(added.map(buildSprite));
  await buildCloudSprites(cloud.entries);
  return cloud.entries;
}

const cloudRankList = () => cloud.entries.map((e) => ({
  spriteId: 'c:' + e.playerId, name: e.name, score: e.score,
  letter: e.letter, me: e.playerId === state.cloud.me,
}));

// ----- お題の画面 -----
// 同じ端末のほかのグループで使っているURLをさがす。
// グループごとに保存が分かれているので、2つ目以降は空欄から始まってしまうため
function borrowEndpoint() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k === STORE_KEY || k.indexOf('krg.v1') !== 0) continue;
      const d = JSON.parse(localStorage.getItem(k));
      const u = d && d.cloud && d.cloud.endpoint;
      if (u && cloudUrlOk(u)) return u;
    }
  } catch (e) { /* 読めなければ、手で貼ってもらう */ }
  return '';
}

function openCloudSetup() {
  let url = state.cloud.endpoint;
  let borrowed = false;
  if (!url) {
    url = borrowEndpoint();
    borrowed = !!url;
  }
  $('cloud-url').value = url;
  $('cloud-status').textContent = borrowed
    ? 'ほかのグループで使っているURLを入れておきました。これでOKなら、そのまま進んでね'
    : '';
  refreshRoundDiff();
  showScreen('cloud');
}

// いまの状態を表す文。openRound と「ランキング更新」で同じものを使う
function roundStatusText() {
  if (cloud.serverOld) {
    return cloud.isHost
      ? '集計用のコードが古いままです。Apps Script を新しくしてデプロイし直してね'
      : '集計用のコードが古いようです。幹事に Apps Script の更新をお願いしてね';
  }
  if (!cloud.round) {
    return cloud.isHost
      ? 'お題が登録されていません。「ランキング更新」を押すと登録し直します'
      : 'お題がまだ登録されていません。幹事に「ランキング更新」を押してもらってね';
  }
  return cloud.entries.length ? '' : 'まだ誰も遊んでいません';
}

function openRound() {
  if (cloud.room) cloud.loading = true;   // 取り寄せる前から「読み込み中」と出す
  renderRound();
  showScreen('round');
  if (!cloud.room) return;
  $('round-status').textContent = cloud.round ? 'ランキングを取り寄せています…' : 'お題を取り寄せています…';
  cloudRefresh().then(() => {
    $('round-status').textContent = roundStatusText();
    renderRound();
  }, () => {
    $('round-status').textContent = cloud.round
      ? 'ランキングを取り寄せられませんでした。通信を確かめてね'
      : 'お題を取り寄せられませんでした。通信を確かめてね';
  });
}

function renderRound() {
  const box = $('round-song');
  box.textContent = '';
  if (!cloud.round) {
    const w = document.createElement('div');
    w.className = 'sub';
    w.textContent = cloud.loading ? 'お題を読み込んでいます…' : 'お題がまだ届いていません';
    box.appendChild(w);
  }
  if (cloud.round) {
    const card = document.createElement('div');
    card.className = 'card';
    if (cloud.round.track.art) {
      const img = document.createElement('img');
      img.src = cloud.round.track.art;
      img.alt = '';
      card.appendChild(img);
    }
    const d = document.createElement('div');
    d.className = 't';
    const nm = document.createElement('b');
    nm.textContent = cloud.round.track.name;
    const ar = document.createElement('span');
    ar.textContent = cloud.round.track.artist + ' ・ ' + DIFF_LABEL[cloud.round.diff];
    d.append(nm, ar);
    card.appendChild(d);
    box.appendChild(card);
  }

  const me = playerById(state.cloud.me);
  const row = $('round-me');
  row.textContent = '';
  row.appendChild(avatarCanvas(me ? me.id : '__none', 46));
  const t = document.createElement('div');
  t.className = 't';
  const b = document.createElement('b');
  b.textContent = me ? me.name : 'あなたの名前を登録';
  const sp = document.createElement('span');
  sp.textContent = me ? 'タップでえらび直す'
    : state.players.length ? 'タップして、この中からえらぶ' : 'タップして名前と顔写真を登録しよう';
  t.append(b, sp);
  row.appendChild(t);

  $('btn-round-play').disabled = !me || !cloud.round;
  // 集計用のURLが分かっていれば、どの端末からでもお題を作れる
  const canHost = cloudUrlOk(state.cloud.endpoint);
  $('btn-round-song').style.display = canHost ? 'block' : 'none';
  $('btn-round-song').textContent = cloud.isHost ? 'お題の曲をかえる' : '自分でお題を作る';
  $('btn-round-link').style.display = cloud.isHost ? 'block' : 'none';
  $('btn-round-share-members').style.display = cloud.isHost ? 'block' : 'none';

  const list = $('round-rank');
  list.textContent = '';
  cloud.entries.forEach((e, i) => {
    const item = document.createElement('div');
    item.className = 'rank-item' + (e.playerId === state.cloud.me ? ' me' : '');
    const no = document.createElement('div');
    no.className = 'no';
    no.textContent = String(i + 1);
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = e.name;
    const sc = document.createElement('div');
    sc.className = 'sc';
    sc.textContent = e.score.toLocaleString();
    const lt = document.createElement('div');
    lt.className = 'lt';
    lt.textContent = e.letter;
    item.append(no, avatarCanvas('c:' + e.playerId, 34, i === 0 ? { crown: true } : {}), nm, sc, lt);
    list.appendChild(item);
  });
}

function newMe() {
  afterEdit = (p) => { state.cloud.me = p.id; saveState(); renderRound(); };
  openEdit(null);
}

// お題の中身はスプレッドシートに置く (配るリンクを短くするため)
async function postRound() {
  const t = cloud.round.track;
  await cloudPost({
    type: 'round', room: cloud.room, diff: cloud.round.diff,
    song: t.name, artist: t.artist, art: t.art, url: t.url,
  });
  const j = await cloudGet(cloud.room);
  cloud.serverOld = !('round' in j);
  return !!(j.round && j.round.url);
}

async function createRound() {
  cloud.room = newRoomCode();
  cloud.round = { track: track.current, diff: state.settings.diff };
  cloud.entries = [];
  cloud.isHost = true;
  rememberRound();
  renderRound();
  showScreen('round');
  $('round-status').textContent = 'お題を用意しています…';
  try {
    $('round-status').textContent = await postRound()
      ? 'お題ができました。「お題リンクをコピー」して配ってね'
      : cloud.serverOld
        ? '集計用のコードが古いままです。Apps Script を新しくしてデプロイし直してね'
        : 'お題を登録できませんでした。「ランキング更新」でやり直せます';
  } catch (e) {
    $('round-status').textContent = 'お題を登録できませんでした。通信を確かめてね';
  }
}

function rememberRound() {
  state.cloud.room = cloud.room;
  state.cloud.round = cloud.round;
  state.cloud.isHost = cloud.isHost;
  saveState();
}

async function cloudTest() {
  const u = $('cloud-url').value.trim();
  if (!cloudUrlOk(u)) {
    $('cloud-status').textContent = '× script.google.com の https から始まるURLを貼ってください';
    return;
  }
  state.cloud.endpoint = u;
  saveState();
  $('cloud-status').textContent = 'ためしています…';
  try {
    await cloudGet('');
  } catch (e) {
    $('cloud-status').textContent = '× つながりません。デプロイの「アクセスできるユーザー」が「全員」になっているか確かめてね';
    return;
  }
  try {
    await cloudPost({
      type: 'score', room: '__test', playerId: '__test', name: 'テスト',
      score: 1, letter: 'D', perfect: 0, great: 0, good: 0, miss: 0, maxCombo: 0,
      song: '接続テスト', diff: '',
    });
    const j = await cloudGet('__test');
    const ok = (j.entries || []).some((e) => e.playerId === '__test');
    $('cloud-status').textContent = ok
      ? '○ つながりました！スプレッドシートに「テスト」の行ができています'
      : '△ 読み取りはできましたが、書き込みが届きませんでした';
  } catch (e) {
    $('cloud-status').textContent = '△ 読み取りはできましたが、書き込みを確かめられませんでした';
  }
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

async function startOnlineTurn() {
  if (!state.cloud.me) { toast('先に名前と写真を登録してね'); return; }
  if (!cloud.round) return;
  initAudio();
  try {
    const data = await prepareTrack(cloud.round.track, (m) => { $('round-status').textContent = m; });
    track.current = cloud.round.track;
    track.data = data;
  } catch (e) {
    $('round-status').textContent = e && e.message ? e.message : '曲を読み込めませんでした';
    return;
  }
  $('round-status').textContent = '';
  session = {
    order: [state.cloud.me], idx: 0, results: [], online: true,
    force: { mode: 'track', diff: cloud.round.diff },
  };
  startTurn();
}

async function finishOnline() {
  const btn = $('btn-result-next');
  btn.disabled = true;
  btn.textContent = 'スコアを送っています…';
  try {
    await (cloud.pending || cloudSubmit(session.results[0]));
  } catch (e) {
    // あとで送り直せるように取っておく
    state.cloud.retry = { room: cloud.room, result: session.results[0] };
    saveState();
    toast('スコアを送れませんでした。「ランキング更新」で送り直せます');
  }
  cloud.pending = null;
  btn.disabled = false;
  btn.textContent = 'ランキングを見る';
  $('btn-rank-title').textContent = 'お題にもどる';
  const r = session.results[0];
  const me = playerById(r.id);
  const list = cloudRankList();
  showRanking(list.length ? list
    : [{ spriteId: r.id, name: me ? me.name : '', score: r.score, letter: r.letter, me: true }]);
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
  const p = currentPlayer(), s = state.settings;
  const karaoke = s.mode === 'karaoke', isTrack = s.mode === 'track';
  const eachSong = isTrack && s.songPick === 'each';
  setAvatar($('next-avatar'), p.id, 150);
  $('next-avatar').className = 'pop';
  $('next-name').textContent = p.name + ' さん';
  const needSong = isTrack && (eachSong || !track.current);
  const what = karaoke ? 'カラオケに合わせる'
    : isTrack ? (needSong ? '曲をえらぶ' : track.current.name)
      : SONGS[s.song].name;
  $('next-info').textContent = `${session.idx + 1} / ${session.order.length} 人目 ・ ${what} ・ ${DIFF_LABEL[s.diff]}\nスマホを渡してね`;
  $('next-info').style.whiteSpace = 'pre-line';
  $('btn-go').textContent = needSong ? '曲をえらぶ'
    : karaoke ? (tempo.ready ? `BPM ${tempo.bpm} のままスタート！` : 'テンポを合わせる')
      : 'スタート！';
  $('btn-retempo').style.display = karaoke && tempo.ready ? 'block' : 'none';
  $('btn-resong').style.display = isTrack && !needSong ? 'block' : 'none';
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

// 叩いてはいけないノーツを差し込む。
// 同じレーンの前後 0.4 秒に本物がない場所だけを選ぶ。
// 別のレーンに音符があっても、そのレーンを叩かなければ誤爆しないため。
// サビ (全員の顔が流れる時間) には出さない
function addTraps(chart, spb, diff, faces, rng) {
  if (diff === 'easy' || !faces.length) return;
  const notes = chart.notes;
  if (!notes.length) return;
  const inFever = (beat) => (chart.fever || []).some(([a, b]) => beat >= a && beat < b);
  const last = notes[notes.length - 1].beat * spb;
  const traps = [];
  let at = (chart.leadBeats || 0) * spb + 5 + rng() * 3;

  while (at < last - 1) {
    const beat = at / spb;
    if (!inFever(beat)) {
      const busy = [];
      for (let i = 0; i < LANES; i++) busy.push(false);
      for (const n of notes) {
        const d = n.beat * spb - at;
        if (d < -TRAP_GAP) continue;
        if (d > TRAP_GAP) break;
        busy[n.lane] = true;
      }
      const free = [];
      for (let i = 0; i < LANES; i++) if (!busy[i]) free.push(i);
      if (free.length) {
        traps.push({
          beat, lane: free[Math.floor(rng() * free.length)], fever: false, trap: true,
          face: faces[Math.floor(rng() * faces.length)],
        });
      }
    }
    at += TRAP_MIN + rng() * (TRAP_MAX - TRAP_MIN);
  }

  if (!traps.length) return;
  notes.push.apply(notes, traps);
  notes.sort((a, b) => a.beat - b.beat);
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
    // みんなでランキングのときは、お題の曲とむずかしさを優先する
    const s = session.force ? Object.assign({}, state.settings, session.force) : state.settings;
    const p = currentPlayer();
    const karaoke = s.mode === 'karaoke';
    const isTrack = s.mode === 'track' && !!track.data;
    const audioOk = actx && actx.state === 'running';
    let chart, spb;
    if (isTrack) {
      const a = track.data.analysis;
      spb = 60 / a.bpm;
      // 最初のノーツが画面に入りきるように、少し後ろから始める
      const from = Math.max(a.offset, APPROACH[s.diff] + 0.7);
      const raw = Beat.buildNotes(a, s.diff, from, a.duration - 0.15);
      const fv = Beat.feverRange(a);
      // 曲の中の時刻を、1拍目を0とした「拍」に直す
      const toBeat = (t) => (t - a.offset) / spb;
      chart = {
        notes: raw.map((n) => ({
          beat: toBeat(n.time), lane: n.lane,
          fever: !!fv && n.time >= fv[0] && n.time < fv[1],
        })),
        fever: fv ? [[toBeat(fv[0]), toBeat(fv[1])]] : [],
        leadBeats: raw.length ? Math.max(0, toBeat(raw[0].time) - 1) : 0,
        totalBeats: toBeat(a.duration),
      };
    } else if (karaoke) {
      spb = 60 / tempo.bpm;
      chart = buildKaraokeChart(tempo.bpm, s.diff, s.length, (Date.now() & 0xffff) + session.idx);
    } else {
      spb = 60 / SONGS[s.song].bpm;
      chart = buildSong(SONGS[s.song], s.diff);
    }
    // サビ・フィーバー中は全員の顔、それ以外は自分の顔
    const rng = mulberry32(session.idx * 977 + 13);
    const everyone = session.order;
    // 罠に使うのは「自分以外の登録メンバー」
    const others = state.players.filter((q) => q.id !== p.id).map((q) => q.id);
    addTraps(chart, spb, s.diff, others, rng);
    for (const n of chart.notes) {
      n.time = n.beat * spb;
      if (n.trap) continue;   // 罠の顔は addTraps が決めている
      n.face = n.fever ? everyone[Math.floor(rng() * everyone.length)] : p.id;
    }

    play = {
      mode: s.mode, diff: s.diff, player: p, spb,
      clock: !karaoke && audioOk ? 'audio' : 'perf',
      notes: chart.notes, fever: chart.fever, leadBeats: chart.leadBeats,
      duration: chart.totalBeats * spb + (karaoke ? 0.5 : isTrack ? 0.4 : 1.2),
      endless: karaoke && s.length === 0,
      approach: APPROACH[s.diff],
      offset: karaoke ? 0 : s.offset / 1000,
      title: isTrack ? track.current.name : '',
      head: 0, wsum: 0, combo: 0, maxCombo: 0, missStreak: 0, judged: 0,
      realCount: chart.notes.filter((n) => !n.trap).length,
      trapHits: 0, trapFaces: {}, trapAt: 0,
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
    } else if (isTrack && play.clock === 'audio') {
      // 曲を鳴らし始める時刻を決め、ゲームの時計は曲の「1拍目」を0にそろえる
      const at = actx.currentTime + 0.6;
      play.origin = at + track.data.analysis.offset;
      trackStop();
      track.source = actx.createBufferSource();
      track.source.buffer = track.data.buffer;
      track.source.connect(master);
      track.source.start(at);
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
  const base = Math.round(1e6 * (0.9 * play.wsum + 0.1 * play.maxCombo) / Math.max(total, 1));
  return Math.max(0, base - play.trapHits * TRAP_PENALTY);
}

const partialTotal = () => Math.max(play.judged, Math.min(play.realCount, MIN_NOTES));

function liveScore() {
  return scoreOf(play.endless ? partialTotal() : play.realCount);
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
  // かんたん: となりのレーンでもOK。ただし罠は救済しない
  if (!n && play.diff === 'easy') n = find((m) => !m.trap && Math.abs(m.lane - lane) === 1);

  if (n && n.trap) {
    n.judged = true;
    n.result = 'trapped';
    play.trapHits++;
    play.trapFaces[n.face] = (play.trapFaces[n.face] || 0) + 1;
    play.combo = 0;
    play.missStreak++;
    play.trapAt = perfNow();
    play.judgeFx = { judge: 'trap', at: play.trapAt };
    play.fx.push({ type: 'ghost', lane: n.lane, face: n.face, at: play.trapAt });
    sfx.trap();
    return;
  }

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
    if (n.judged) continue;
    if (n.trap) { n.judged = true; n.result = 'avoided'; }   // 避けられた
    else judgeNote(n, 'miss', 0);
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
  trackStop();
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
  const score = scoreOf(early || play.endless ? partialTotal() : play.realCount);
  const r = {
    id: play.player.id, score, letter: rankLetter(score),
    counts: play.counts, maxCombo: play.maxCombo,
    avgOffset: play.offN ? Math.round(1000 * play.offSum / play.offN) : null,
    traps: play.trapHits,
    trapNames: Object.keys(play.trapFaces).map((id) => {
      const q = playerById(id);
      return (q ? q.name : 'だれか') + 'を' + play.trapFaces[id] + '回';
    }).join('、'),
  };
  session.results.push(r);
  if (session.online) {
    cloud.pending = cloudSubmit(r);
    cloud.pending.catch(() => {});   // 失敗は finishOnline 側で伝える
  }
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
  const tn = $('st-trap');
  if (r.traps) {
    tn.style.display = 'block';
    tn.textContent = r.trapNames + ' 叩いてしまった（−' + (r.traps * TRAP_PENALTY).toLocaleString() + '点）';
  } else {
    tn.style.display = 'none';
  }
  $('result-rank').textContent = '';
  $('btn-result-next').textContent = session.online ? 'ランキングを見る'
    : session.idx + 1 < session.order.length ? 'つぎの人へ' : '結果発表へ！';
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

// entries: [{ spriteId, name, score, letter, me }] を点数順に並べたもの
function showRanking(entries) {
  const ranked = entries.slice().sort((a, b) => b.score - a.score);
  const n = ranked.length;
  const podium = $('podium'), list = $('rank-list');
  podium.textContent = '';
  list.textContent = '';
  list.style.visibility = 'hidden';

  const cols = {};
  [[1, 'p2'], [0, 'p1'], [2, 'p3']].forEach(([i, cls]) => {
    const r = ranked[i];
    if (!r) return;
    const col = document.createElement('div');
    col.className = 'col ' + cls;
    col.appendChild(avatarCanvas(r.spriteId, i === 0 ? 92 : 70, i === 0 ? { crown: true, sparkle: true } : {}));
    const nm = document.createElement('div'); nm.className = 'pname'; nm.textContent = r.name;
    const sc = document.createElement('div'); sc.className = 'pscore'; sc.textContent = r.score.toLocaleString();
    const bl = document.createElement('div'); bl.className = 'block'; bl.textContent = String(i + 1);
    col.append(nm, sc, bl);
    podium.appendChild(col);
    cols[i] = col;
  });

  ranked.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'rank-item' + (r.me ? ' me' : '');
    const no = document.createElement('div'); no.className = 'no'; no.textContent = String(i + 1);
    const av = avatarCanvas(r.spriteId, 34, n >= 3 && i === n - 1 ? { tears: true } : i === 0 ? { crown: true } : {});
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = r.name;
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

// スマホ1台を回して遊んだときの結果発表
function showLocalRanking() {
  $('btn-rank-title').textContent = 'タイトルへ';
  showRanking(session.results.map((r) => {
    const p = playerById(r.id);
    return { spriteId: r.id, name: p ? p.name : '', score: r.score, letter: r.letter };
  }));
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

// 長い曲名は「…」で切る
function ellipsis(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
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
    if (n.trap) {
      // 叩いてはいけないノーツ。色と×印の両方で分かるようにする
      ctx.strokeStyle = TRAP_COLOR;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(cx, y, r, 0, TAU); ctx.stroke();
      // ×印は細めにして、誰の顔かは分かるようにしておく
      ctx.lineCap = 'round';
      const d = r * 0.44;
      const cross = () => {
        ctx.beginPath();
        ctx.moveTo(cx - d, y - d); ctx.lineTo(cx + d, y + d);
        ctx.moveTo(cx + d, y - d); ctx.lineTo(cx - d, y + d);
        ctx.stroke();
      };
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';   // 明るい顔でも見えるように影をつける
      ctx.lineWidth = 8;
      cross();
      ctx.strokeStyle = TRAP_COLOR;
      ctx.lineWidth = 5;
      cross();
      ctx.lineCap = 'butt';
      ctx.lineWidth = 4;
    } else {
      ctx.strokeStyle = n.fever ? '#ffe9a0' : LANE_COLOR[n.lane];
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, y, r, 0, TAU); ctx.stroke();
    }
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

  // 罠を叩いてしまったときは、画面のふちを赤くする
  const tf = 1 - (now - play.trapAt) / 0.45;
  if (tf > 0) {
    const g2 = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.7);
    g2.addColorStop(0, 'rgba(255,59,59,0)');
    g2.addColorStop(1, `rgba(255,59,59,${0.55 * tf})`);
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);
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
  } else if (play.title) {
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = '#c3b8ea';
    ctx.fillText(ellipsis(play.title, w - 96 - 58), 96, hudTop + 92);
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
  on('btn-setup-next', () => {
    const t = state.settings;
    // 全員おなじ曲のときは、始める前に1曲えらんでおく
    if (t.mode === 'track' && t.songPick === 'same' && !track.current) openSong(beginSession, 'setup');
    else beginSession();
  });

  // 曲さがし
  on('btn-song-search', doSearch);
  on('btn-net-check', netCheck);
  on('btn-song-back', () => {
    track.onPicked = null;
    if (track.backTo === 'round') openRound();
    else if (track.backTo === 'cloud') openCloudSetup();
    else if (session) showNext();
    else showScreen('setup');
  });
  $('song-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  $('song-q').addEventListener('search', doSearch);

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
    const t = state.settings;
    if (t.mode === 'track' && (t.songPick === 'each' || !track.current)) openSong(startTurn);
    else if (t.mode === 'karaoke' && !tempo.ready) openTempo();
    else startTurn();
  });
  on('btn-retempo', openTempo);
  on('btn-resong', () => openSong(startTurn));
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
    if (session.online) { finishOnline(); return; }
    session.idx++;
    if (session.idx < session.order.length) showNext();
    else showLocalRanking();
  });
  on('btn-rank-again', () => {
    revealTimers.forEach(clearTimeout);
    if (session && session.online) startOnlineTurn();
    else beginSession();
  });
  on('btn-rank-title', () => {
    revealTimers.forEach(clearTimeout);
    const wasOnline = session && session.online;
    session = null;
    if (wasOnline) openRound();
    else showTitle();
  });

  // みんなでランキング
  on('btn-online', () => {
    if (!cloudUrlOk(state.cloud.endpoint)) openCloudSetup();
    else if (cloud.round && !cloud.isHost) openRound();
    else openCloudSetup();
  });
  on('btn-cloud-test', cloudTest);
  on('btn-cloud-back', showTitle);
  on('btn-cloud-next', () => {
    const u = $('cloud-url').value.trim();
    if (!cloudUrlOk(u)) { $('cloud-status').textContent = '× script.google.com の https から始まるURLを貼ってください'; return; }
    state.cloud.endpoint = u;
    saveState();
    openSong(createRound, 'cloud');
  });
  on('btn-round-play', startOnlineTurn);
  on('btn-round-song', () => openSong(createRound, 'round'));
  on('btn-round-back', () => { showTitle(); });
  on('btn-round-refresh', () => {
    $('round-status').textContent = 'ランキングを取り寄せています…';
    cloudRefresh().then(() => {
      $('round-status').textContent = roundStatusText();
      renderRound();
    }, () => { $('round-status').textContent = 'ランキングを取り寄せられませんでした。通信を確かめてね'; });
  });
  on('btn-round-link', async () => {
    const link = makeRoundLink();
    $('round-status').textContent = await copyText(link)
      ? 'お題リンクをコピーしました。LINEなどに貼って配ってね'
      : 'コピーできませんでした。アドレス欄のURLをそのまま送ってね';
  });
  $('round-me').addEventListener('click', () => {
    sfx.click();
    // 登録済みの人がいれば、そこからえらぶ
    if (state.players.length) openWho();
    else newMe();
  });
  on('btn-who-new', () => { $('modal-who').classList.remove('on'); newMe(); });
  on('btn-round-share-members', shareMembers);
  on('btn-import', () => $('file-members').click());
  $('file-members').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      let list = null;
      try {
        const d = JSON.parse(String(rd.result));
        list = Array.isArray(d) ? d : d && Array.isArray(d.members) ? d.members : null;
      } catch (err) { list = null; }
      if (!list) { toast('このファイルは読み込めませんでした'); return; }
      const added = importMembers(list);
      await Promise.all(added.map(buildSprite));
      renderPlayers();
      toast(added.length ? `${added.length}人を読み込みました` : 'すでに登録済みのメンバーでした');
    };
    rd.readAsText(f);
  });
  on('btn-who-cancel', () => $('modal-who').classList.remove('on'));

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
// お題リンクから開かれたときは、その曲とむずかしさで始める
const roundLink = readRoundLink();
if (roundLink) {
  state.cloud.endpoint = roundLink.endpoint;
  cloud.room = roundLink.room;
  // 短いリンクのときは、お題の中身はあとから取り寄せる
  cloud.round = roundLink.track ? { track: roundLink.track, diff: roundLink.diff } : null;
  cloud.isHost = false;
} else if (state.cloud.room && state.cloud.round) {
  cloud.room = state.cloud.room;
  cloud.round = state.cloud.round;
  cloud.isHost = !!state.cloud.isHost;
}
if (!state.cloud.me && state.players.length === 1) state.cloud.me = state.players[0].id;
resize();
bindSetup();
bindAll();
// 「まだ登録していない人」用の顔
const blankFace = buildSprite({ id: '__none', name: '？', photo: null, color: '#6b5f9c' });
Promise.all(state.players.map(buildSprite).concat([blankFace])).then(() => {
  if (roundLink) openRound();
  else showTitle();
});
requestAnimationFrame(frame);
