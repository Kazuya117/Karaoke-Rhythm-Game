# CLAUDE.md — Karaoke-Rhythm-Game（顔ノーツ☆カラオケバトル / PTAリズムバトル）

## これは何か
仲間の顔写真がノーツになって流れてくるブラウザ用リズムゲーム。外部ライブラリなし（`index.html` + `game.js` + `beat.js`）。
公開先は GitHub Pages: https://kazuya117.github.io/Karaoke-Rhythm-Game/ （`main` に push すると 1〜2 分で反映）。
機能と遊び方の正本は `README.md`。本ファイルは「次のセッションが最初に知るべき事情」だけ書く。

## 作業場所（2026-10-21 以降）
- **編集は WSL 側のこの clone（`~/apps/Karaoke-Rhythm-Game`）で行う。**
- 2026-09-21〜09-27 は Windows 側 Claude Code（OneDrive 内 `ドキュメント/GitHub/Karaoke-Rhythm-Game`）で開発した。
  その OneDrive コピーは GitHub `main` より 7 commit 古く、以後は使わない（消すか見るだけ）。
- 2026-09-28〜10-07 は Cursor（Cursor Agent・PR #1〜#3）でも改造している。履歴は `git log` を見る。

## いま有効な運用上の事実
- **使うグループは b だけ**: `https://kazuya117.github.io/Karaoke-Rhythm-Game/?g=b`（PR #2 で 1 と 3 は廃止。素の URL や `?g=1` `?g=3` は b へ自動で移る）。
- タイトルは 2026-10-07 に「PTAリズムバトル」へ変更（PR #3）。README の見出しはまだ旧名のまま。
- 集計は幹事（中川さん）の Google スプレッドシート + Apps Script（`server/code.gs`・`CODE_VERSION = 3`）。
  **Apps Script の `/exec` URL は repo にもこの file にも書かない**（知っている人は誰でも書き込める）。所在は中川さんの「デプロイを管理」画面。
- `code.gs` を変えたら `CODE_VERSION` と `game.js` の `NEED_CODE_VERSION` を同時に上げ、Apps Script 側は「デプロイを管理 → 編集 → 新バージョン」で再デプロイ（保存だけでは反映されない）。
- 配布済み URL は変えない。更新は `index.html` が 10 分ごとの目印付きで `game.js` を読む仕組みで届く。`index.html` を変えたら `data-html` と `game.js` の `NEED_HTML` を同じ数字に上げる。
- メンバーの名前と似顔絵は repo に入れない（スプレッドシートと各端末だけ）。グループ b の 6 名分の読み込み用 JSON は 2026-09-27 の Windows セッションで添付として渡したもので、**ディスク上の所在は UNKNOWN**（Downloads・デスクトップに無し）。必要なら「ファイルからまとめて読み込む」用に作り直す。
- ランキングは名前で 1 人にまとめてベストスコアを残す（2026-09-27 実装）。

## 過去に踏んだ落とし穴（再発防止）
- 「メンバーをみんなに配る」は、そのグループのメンバー一覧を**丸ごと置き換える**。別グループの画面から押すと相手が消える。配る前にタイトル下の `グループ b` 表示を確認する。
- Apps Script を貼り直しただけ（新バージョン未デプロイ）だと `members` シートに `group` 列が増えず、全グループが混ざる。ゲーム側は古い版を検知して送信を止める。
- LINE などアプリ内ブラウザでは Apple の曲検索が遮断される。検索は Apps Script が中継するが、音源は Safari で開き直す。
- iPhone の消音スイッチで効果音が鳴らない件は、タップ時に音声を再有効化する処理で対応済み。

## 動かし方（手元）
```bash
python3 -m http.server 8765   # ブラウザで http://localhost:8765/?g=b
```
