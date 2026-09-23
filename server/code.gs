/**
 * 顔ノーツ☆カラオケバトル — みんなのスコアを集める受け口
 *
 * 【使い方】このファイルの中身を Google Apps Script に貼り付けて「ウェブアプリ」として
 * デプロイします。手順は README.md の「みんなでランキングの準備」を見てください。
 *
 * 仕組み:
 *   GET  ?room=XXXX            … そのお題のランキングと、メンバー一覧を返す
 *   POST {type:'score', ...}   … スコアを記録する (同じ人はベストスコアだけ残す)
 *   POST {type:'members', ...} … メンバー(名前と似顔絵)を登録する
 *
 * メンバーの似顔絵は、このスプレッドシートの中だけに入ります。
 * リンクを知っている仲間にだけ配られ、インターネットには公開されません。
 *
 * ブラウザから呼べるように、POST は text/plain で受け取ります
 * (application/json だと事前確認の通信が入って、Apps Script では失敗するため)。
 */

var SHEET_NAME = 'scores';
var MEMBER_SHEET = 'members';
var MEMBER_HEADERS = ['memberId', 'name', 'avatar', 'updatedAt'];
var HEADERS = ['room', 'playerId', 'name', 'score', 'letter',
  'perfect', 'great', 'good', 'miss', 'maxCombo', 'attempts',
  'song', 'diff', 'updatedAt', 'avatar'];
var MAX_AVATAR = 40000;   // 1セルに入れられる上限に余裕を持たせる

function doGet(e) {
  try {
    var room = String((e && e.parameter && e.parameter.room) || '').trim();
    if (!room) return out({ ok: true, ping: true, message: 'ready' });
    return out({ ok: true, room: room, entries: readRoom(room), members: readMembers() });
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
      return out({ ok: true, members: writeMembers(body.list || []) });
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

// ----- メンバー (名前と似顔絵) -----
function readMembers() {
  var sheet = getMemberSheet();
  var rows = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    if (!String(rows[i][0])) continue;
    list.push({
      memberId: String(rows[i][0]),
      name: String(rows[i][1]),
      avatar: String(rows[i][2] || ''),
    });
  }
  return list;
}

// 幹事が配るたびに、まるごと置きかえる
function writeMembers(list) {
  var sheet = getMemberSheet();
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, MEMBER_HEADERS.length).clearContent();
  var now = new Date();
  var rows = [];
  for (var i = 0; i < Math.min(list.length, 30); i++) {
    var m = list[i] || {};
    var avatar = String(m.avatar || '');
    rows.push([
      String(m.memberId || ('m' + (i + 1))),
      String(m.name || '').slice(0, 20),
      avatar.length > MAX_AVATAR ? '' : avatar,
      now,
    ]);
  }
  if (rows.length) sheet.getRange(2, 1, rows.length, MEMBER_HEADERS.length).setValues(rows);
  return readMembers();
}

function getMemberSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MEMBER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MEMBER_SHEET);
    sheet.appendRow(MEMBER_HEADERS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(MEMBER_HEADERS);
    sheet.setFrozenRows(1);
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
