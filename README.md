# (WIP) Slack Gemini Q&A Bot (Google Apps Script)

Google Apps Script + Slack + Google Gemini (Generative Language API) を用いて、Slack 上で @メンションやメッセージに自動応答する Q&A ボットです。低レイテンシで Slack へ ACK しつつ、Gemini への遅延処理・回答更新を行えるように設計されています。

---

## 🧩 主な機能

- Slack の `app_mention` / `message` イベントを取得して質問テキストを抽出
- Google Gemini (gemini-2.5-flash) へ質問を投げ、整形した回答を生成
- 重複イベント (Slack の再送) を 10 分間キャッシュし多重返信を防止
- Bot 自身のメッセージを無視してループ防止
- スプレッドシートへの簡易ログ出力 (Logs シート自動作成)
- 失敗時はエラーログを記録してフォールバックメッセージを返却

---

## 🏗 アーキテクチャ概要

```
Slack (Events API)
    │  (event JSON POST)
    ▼
Google Apps Script WebApp (doPost)
  - 受信 & 重複判定
  - Gemini 呼び出し → 回答生成
  - Slack へ投稿 or 既存メッセージ更新
    │
    ▼
Slack チャネル / スレッド
```

### 主要ファイル

| ファイル          | 役割                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `Code.js`         | 本体ロジック (Slack 受信、Gemini 呼び出し、Slack 投稿、重複制御、ログ) |
| `appsscript.json` | Apps Script プロジェクト設定 (スコープ, WebApp 権限など)               |
| `deploy.sh`       | clasp CLI を使ったデプロイスクリプト                                   |

---

## 📦 必要なもの

- Slack ワークスペース (アプリを作成できる権限)
- Google アカウント (Google Apps Script / Google AI Studio 利用)
- Google Gemini API Key (Google AI Studio で発行)
- `clasp` (ローカルから Apps Script へ push/deploy するため、Node.js が必要)

---

## 🔑 Slack アプリ設定手順 (推奨)

1. [Slack API: Your Apps](https://api.slack.com/apps) で新規アプリ作成 (From scratch)
2. Basic Information > App-Level Tokens (必要なら) / Display Information を整備
3. OAuth & Permissions:
   - Bot Token Scopes (例):
     - `app_mentions:read`
     - `chat:write`
     - `chat:write.public` (パブリックチャンネルでスレッド外投稿が必要な場合)
     - `channels:history` (パブリックチャンネルで message イベントを扱う場合)
     - `groups:history` (プライベートチャンネル対応が必要なら)
     - `im:history`, `mpim:history` (DM/マルチDM対応が必要なら)
4. Event Subscriptions を有効化:
   - Request URL に 後述の Apps Script デプロイ URL ( https://script.google.com/macros/s/xxxxxxxx/exec ) を設定
   - Subscribe to bot events:
     - `app_mention`
     - `message.channels` (または用途に応じて `message.groups` / `message.im` / `message.mpim`)
5. Install App to Workspace → Bot User OAuth Token ( `xoxb-...` ) を取得
6. 変更があれば再インストール / Reinstall でトークン更新

---

## 🤖 Google Gemini API Key 取得

1. [Google AI Studio](https://aistudio.google.com/) にアクセス
2. API Key を発行
3. 利用上限 (クォータ) を確認し、必要ならプロジェクトや課金を調整

---

## 🛠 Google Apps Script プロジェクト準備

### 1. ローカルに clone / 作業

```
git clone <本リポジトリURL>
cd Slack-gemini-Q_and_A
```

### 2. clasp をインストール

```
npm install -g @google/clasp
```

### 3. Google ログイン & プロジェクト紐付け

```
clasp login
clasp create --type webapp --title "Slack Gemini Q&A" --rootDir ./
# 既存プロジェクトに紐づける場合は .clasp.json を調整
```

### 4. スクリプトプロパティ設定 (Apps Script 管理画面 > プロジェクトのプロパティ > スクリプトのプロパティ)

| キー              | 値                                      |
| ----------------- | --------------------------------------- |
| `GEMINI_API_KEY`  | 取得した Gemini API キー                |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`) |

### 5. デプロイ

```
./deploy.sh
# または手動:
clasp push
clasp deploy --description "Initial"
```

### 6. Web アプリ URL を Slack の Event Subscriptions に設定

- デプロイ後に表示される `https://script.google.com/macros/s/.../exec` を Slack の Request URL に貼付
- Slack 側で Verification が成功することを確認

---

## ⚙ 動作フロー詳細

1. Slack → WebApp に JSON POST
2. `doPost` が: 入力ログ / JSON パース / 重複チェック / Bot 自己メッセージ除外 / テキスト整形
3. Gemini API へプロンプト送信 (`getGeminiResponse`)
4. Slack へ投稿 (`postToSlack`)
5. ログはスプレッドシート `Logs` シートに追加

(コードには将来的なトリガベース分割 `triggeredGeminiHandler` の雛形も含まれています。現状は同期的に Gemini を呼んでいます。長時間応答が増える場合は on-demand でトリガを作成する構造に発展可能です。)

---

## 📝 回答フォーマット ポリシー

`getGeminiResponse` 内で以下を指示:

- Slack mrkdwn を使用
- 回答の正確性に限界がある旨を案内
- 不明確な質問には明確化を促す

必要に応じてプロンプトを編集して組織ポリシーを反映して下さい。

---

## 🧪 確認方法

1. 対象チャンネルで Bot をメンション: `@your-bot 質問内容` もしくは Bot が参加するチャンネルに直接質問
2. ログ: スプレッドシート > 拡張機能 > Apps Script > 対象プロジェクト > 実行ログ or シート `Logs`
3. エラー時: Slack にフォールバック文言 + `Logs` シートで詳細

---

## 🪪 セキュリティ / 運用上の注意

- 現在 `appsscript.json` の `webapp.access` は `ANYONE_ANONYMOUS`。不特定アクセスを避ける場合は UI から再デプロイ時にアクセス権を制限 (例: "Only myself") し、Slack からのアクセスのみが通るかを検証してください。
- API キーやトークンは「スクリプトプロパティ」に保存し、コードに直書きしない
- 大量スパムを避けるには: 投稿元ユーザーやチャンネルのホワイトリスト化、レートリミット用キャッシュを追加可能

---

## ♻ 重複イベント制御

Slack は 3 秒以内に 2xx が返らないと再送することがあります。`isDuplicateSlackEvent` により `event_id` を 10 分キャッシュし同一処理を抑止しています。TTL は `DUP_EVENT_CACHE_TTL` で調整可能。

---

## 🚨 トラブルシューティング

| 症状                                     | 確認ポイント                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Slack 側で Request URL Verification 失敗 | デプロイ URL が `/exec` で終わっているか / 直近で再デプロイ後 URL 変わっていないか |
| 返信がこない                             | `Logs` シート / 実行ログ / Slack App の Event Subscriptions が有効か               |
| 401 / authorization error                | Slack Bot Token 設定ミス / スコープ不足 / 再インストール忘れ                       |
| Gemini エラー                            | API キー有効性 / 利用クォータ / モデル名の変更有無                                 |
| 連続重複で返信されない                   | `event_id` がキャッシュされている (TTL 待つ or TTL 短縮)                           |

---

## 🔍 拡張アイデア

- スレッド内で逐次ストリーミング風 (placeholder → update) 実装
- 質問分類 (タグ付け / FAQ 参照) 前処理
- Rate limit / concurrency 制御
- 管理用ダッシュボード (回答数 / エラー率)
- 日本語/英語 自動判定とバイリンガル回答
- 長文要約 / ファイル添付テキスト抽出

---

## 📄 ライセンス

組織ポリシーに合わせて追記してください (例: MIT, Apache-2.0 など)。

---

## 🙋 よくある変更点の場所

| 目的               | 対応箇所                                               |
| ------------------ | ------------------------------------------------------ |
| プロンプト調整     | `getGeminiResponse` 内 `prompt` 文字列                 |
| キャッシュ時間変更 | 定数 `DUP_EVENT_CACHE_TTL`                             |
| モデル変更         | `GEMINI_API_URL` のモデル部分 (例: `gemini-2.0-flash`) |
| ログ出力先変更     | `logToSheet` 関数                                      |

---

## ✅ 簡易チェックリスト

- [ ] Slack アプリ作成 & インストール
- [ ] Bot Token Scopes 設定 (app_mentions:read, chat:write, ...)
- [ ] Event Subscriptions 有効化 & URL 設定
- [ ] スクリプトプロパティに API キー & トークン設定
- [ ] `clasp push` / デプロイ完了
- [ ] メンションで応答動作確認
- [ ] ログ/エラー確認

---

何か改善したい点があれば Issue / PR やチャットでフィードバックしてください。Happy building! 🚀
