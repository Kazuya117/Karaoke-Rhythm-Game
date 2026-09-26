/**
 * 顔ノーツ☆カラオケバトル — みんなのスコアを集める受け口
 *
 * 【使い方】このファイルの中身を Google Apps Script に貼り付けて「ウェブアプリ」として
 * デプロイします。手順は README.md の「みんなでランキングの準備」を見てください。
 *
 * 仕組み:
 *   GET  ?room=XXXX            … そのお題のランキングと、メンバー一覧を返す
 *   GET  ?q=きょくめい          … 曲を検索する (ブラウザから Apple に直接つながらないとき用)
 *   POST {type:'score', ...}   … スコアを記録する (同じ人はベストスコアだけ残す)
 *   POST {type:'members', ...} … メンバー(名前と似顔絵)を登録する
 *   POST {type:'round', ...}   … お題(曲とむずかしさ)を登録する
 *
 * お題をここに置くことで、配るリンクを短くしています。
 *
 * メンバーの似顔絵は、このスプレッドシートの中だけに入ります。
 * リンクを知っている仲間にだけ配られ、インターネットには公開されません。
 *
 * ブラウザから呼べるように、POST は text/plain で受け取ります
 * (application/json だと事前確認の通信が入って、Apps Script では失敗するため)。
 */

var SHEET_NAME = 'scores';
var MEMBER_SHEET = 'members';
var MEMBER_HEADERS = ['memberId', 'name', 'avatar', 'updatedAt', 'group'];
var ROUND_SHEET = 'rounds';
var ROUND_HEADERS = ['room', 'song', 'artist', 'art', 'url', 'diff', 'createdAt'];
var HEADERS = ['room', 'playerId', 'name', 'score', 'letter',
  'perfect', 'great', 'good', 'miss', 'maxCombo', 'attempts',
  'song', 'diff', 'updatedAt', 'avatar'];
var MAX_AVATAR = 40000;   // 1セルに入れられる上限に余裕を持たせる

function doGet(e) {
  try {
    var q = String((e && e.parameter && e.parameter.q) || '').trim();
    if (q) return out(searchITunes(q));
    var room = String((e && e.parameter && e.parameter.room) || '').trim();
    if (!room) return out({ ok: true, ping: true, message: 'ready' });
    return out({
      ok: true, room: room, round: readRound(room),
      entries: readRoom(room), members: readMembers(groupOf(e && e.parameter)),
    });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.type === 'ping') return out({ ok: true, ping: true });
    if (body.type === 'members') {
      lock.waitLock(20000);
      return out({ ok: true, members: writeMembers(body.list || [], groupOf(body)) });
    }
    if (body.type === 'round') {
      lock.waitLock(20000);
      return out({ ok: true, round: writeRound(body) });
    }
    if (body.type !== 'score') return out({ ok: false, error: 'unknown type' });

    var room = String(body.room || '').trim();
    var playerId = String(body.playerId || '').trim();
    if (!room || !playerId) return out({ ok: false, error: 'room と playerId が必要です' });

    lock.waitLock(20000);
    var sheet = getSheet();
    var rows = sheet.getDataRange().getValues();
    var col = {};
    HEADERS.forEach(function (h, i) { col[h] = i; });

    var score = Math.max(0, Math.min(1000000, Number(body.score) || 0));
    var avatar = String(body.avatar || '');
    if (avatar.length > MAX_AVATAR) avatar = '';

    // 同じお題・同じ人の行をさがす
    var at = -1;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][col.room]) === room && String(rows[i][col.playerId]) === playerId) { at = i; break; }
    }

    var attempts = at < 0 ? 1 : (Number(rows[at][col.attempts]) || 0) + 1;
    var best = at < 0 ? -1 : Number(rows[at][col.score]) || 0;
    var now = new Date();

    if (at >= 0 && score <= best) {
      // ベストは更新しないが、挑戦回数だけ増やす
      sheet.getRange(at + 1, col.attempts + 1).setValue(attempts);
      sheet.getRange(at + 1, col.updatedAt + 1).setValue(now);
      return out({ ok: true, kept: true, best: best, attempts: attempts, entries: readRoom(room) });
    }

    var row = [];
    row[col.room] = room;
    row[col.playerId] = playerId;
    row[col.name] = String(body.name || '').slice(0, 20);
    row[col.score] = score;
    row[col.letter] = String(body.letter || '').slice(0, 4);
    ['perfect', 'great', 'good', 'miss', 'maxCombo'].forEach(function (k) {
      row[col[k]] = Math.max(0, Number(body[k]) || 0);
    });
    row[col.attempts] = attempts;
    row[col.song] = String(body.song || '').slice(0, 120);
    row[col.diff] = String(body.diff || '').slice(0, 12);
    row[col.updatedAt] = now;
    row[col.avatar] = avatar || (at >= 0 ? rows[at][col.avatar] : '');

    if (at < 0) sheet.appendRow(row);
    else sheet.getRange(at + 1, 1, 1, HEADERS.length).setValues([row]);

    return out({ ok: true, best: score, attempts: attempts, entries: readRoom(room) });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/**
 * 外部サイトへの接続を許可するための関数。
 *
 * エディタ上部の関数一覧で「authorize」を選んで「実行」を1回押し、
 * 出てくる画面で許可してください。これをしないと中継が使えません。
 */
function authorize() {
  var res = UrlFetchApp.fetch('https://itunes.apple.com/search?term=test&limit=1', { muteHttpExceptions: true });
  Logger.log('つながりました: ' + res.getResponseCode());
  return res.getResponseCode();
}

// ----- 曲の検索を中継する -----
// LINE のアプリ内ブラウザなど、Apple に直接つながらない環境のための逃げ道。
// ここ (Google のサーバー) から取りに行って、結果だけ返す。
function searchITunes(term) {
  var url = 'https://itunes.apple.com/search?media=music&entity=song&limit=20&country=JP&term='
    + encodeURIComponent(term);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'itunes ' + res.getResponseCode() };
    var j = JSON.parse(res.getContentText());
    var list = [];
    (j.results || []).forEach(function (x) {
      if (!x.previewUrl) return;
      list.push({
        trackId: x.trackId, trackName: x.trackName, artistName: x.artistName,
        artworkUrl100: x.artworkUrl100, previewUrl: x.previewUrl,
      });
    });
    return { ok: true, results: list, resultCount: list.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ----- お題 (曲とむずかしさ) -----
function readRound(room) {
  var rows = getRoundSheet().getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== room) continue;
    return {
      song: String(rows[i][1]), artist: String(rows[i][2]),
      art: String(rows[i][3]), url: String(rows[i][4]), diff: String(rows[i][5]),
    };
  }
  return null;
}

function writeRound(body) {
  var room = String(body.room || '').trim();
  if (!room) return null;
  var sheet = getRoundSheet();
  var rows = sheet.getDataRange().getValues();
  var row = [
    room,
    String(body.song || '').slice(0, 120),
    String(body.artist || '').slice(0, 120),
    String(body.art || '').slice(0, 300),
    String(body.url || '').slice(0, 400),
    String(body.diff || 'normal').slice(0, 12),
    new Date(),
  ];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === room) {
      sheet.getRange(i + 1, 1, 1, ROUND_HEADERS.length).setValues([row]);
      return readRound(room);
    }
  }
  sheet.appendRow(row);
  return readRound(room);
}

function getRoundSheet() {
  return getOrCreate(ROUND_SHEET, ROUND_HEADERS);
}

function getOrCreate(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ----- メンバー (名前と似顔絵) -----
// グループごとに分けて持つ。1つのスプレッドシートで複数の仲間内をさばけるように
function groupOf(o) {
  // POST は group、GET は g という名前で届く
  var v = '';
  if (o) v = o.group !== undefined && o.group !== '' ? o.group : (o.g || '');
  return String(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
}

function readMembers(group) {
  var rows = getMemberSheet().getDataRange().getValues();
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    if (!String(rows[i][0])) continue;
    if (String(rows[i][4] || '') !== group) continue;
    list.push({
      memberId: String(rows[i][0]),
      name: String(rows[i][1]),
      avatar: String(rows[i][2] || ''),
    });
  }
  return list;
}

// 幹事が配るたびに、そのグループのぶんだけ置きかえる
function writeMembers(list, group) {
  var sheet = getMemberSheet();
  var rows = sheet.getDataRange().getValues();
  var keep = [];
  for (var i = 1; i < rows.length; i++) {
    if (!String(rows[i][0])) continue;
    if (String(rows[i][4] || '') !== group) keep.push(rows[i].slice(0, MEMBER_HEADERS.length));
  }
  var now = new Date();
  var fresh = [];
  for (var k = 0; k < Math.min(list.length, 30); k++) {
    var m = list[k] || {};
    var avatar = String(m.avatar || '');
    fresh.push([
      String(m.memberId || ('m' + (k + 1))),
      String(m.name || '').slice(0, 20),
      avatar.length > MAX_AVATAR ? '' : avatar,
      now, group,
    ]);
  }
  var all = keep.concat(fresh);
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, MEMBER_HEADERS.length).clearContent();
  if (all.length) sheet.getRange(2, 1, all.length, MEMBER_HEADERS.length).setValues(all);
  return readMembers(group);
}

function getMemberSheet() {
  var sheet = getOrCreate(MEMBER_SHEET, MEMBER_HEADERS);
  // 以前の形 (group 列がない) のシートにも、列だけ足しておく
  if (String(sheet.getRange(1, MEMBER_HEADERS.length).getValue() || '') !== 'group') {
    sheet.getRange(1, MEMBER_HEADERS.length).setValue('group');
  }
  return sheet;
}

function readRoom(room) {
  var rows = getSheet().getDataRange().getValues();
  var col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][col.room]) !== room) continue;
    list.push({
      playerId: String(rows[i][col.playerId]),
      name: String(rows[i][col.name]),
      score: Number(rows[i][col.score]) || 0,
      letter: String(rows[i][col.letter]),
      perfect: Number(rows[i][col.perfect]) || 0,
      great: Number(rows[i][col.great]) || 0,
      good: Number(rows[i][col.good]) || 0,
      miss: Number(rows[i][col.miss]) || 0,
      maxCombo: Number(rows[i][col.maxCombo]) || 0,
      attempts: Number(rows[i][col.attempts]) || 1,
      avatar: String(rows[i][col.avatar] || ''),
    });
  }
  list.sort(function (a, b) { return b.score - a.score; });
  return list;
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
