# Slack Gemini Q&A Bot (Google Apps Script)

Google Apps Script、Slack、Google Gemini APIを用いて、Slack上でスレッドの文脈や画像ファイルを理解して応答する、高機能なQ&Aボットです。

---

## 🧩 主な機能

- **スレッドの文脈を考慮した会話機能**: スレッド内の過去のやり取り（直近10件）を理解し、文脈に沿った回答を生成します。
- **マルチモーダル対応**: 投稿に添付された画像ファイル（JPEG, PNG, GIF, WEBP）を認識し、内容について回答できます。
- **非同期処理による安定応答**: Slackからのリクエストには即座に「思考中...」と応答し、時間のかかるGemini APIとの通信はバックグラウンドで実行。タイムアウトを防ぎ、安定した動作を実現します。
- **コスト管理機能**:
    - **出力制限**: 回答の最大長を制限し、不要なコストを削減します。
    - **入力制限**: 読み込む会話履歴の件数を制限し、入力コストを削減します。
- **重複イベント防止**: Slackからのイベント再送による多重返信をキャッシュで防ぎます。
- **ループ防止**: Bot自身のメッセージには応答しません。
- **ロギング**: 実行ログやエラーをGoogleスプレッドシートに記録します。

---

## 🏗 アーキテクチャ概要

本ボットは、Slackのタイムアウトを回避するため、2段階の非同期処理アーキテクチャを採用しています。

```
Slack (Events API)
    │
    │ 1. @メンション or メッセージ投稿 (画像含む)
    │
    ▼
Google Apps Script WebApp (doPost)
  - (高速処理)
  - 1. Slackへ即時ACK応答 (HTTP 200)
  - 2. 「思考中です...」とSlackに仮投稿
  - 3. 後続処理のためのトリガーを作成
    │
    │ 2. トリガー発火 (5秒後)
    │
    ▼
Google Apps Script (triggeredGeminiHandler)
  - (低速処理)
  - 1. Slackスレッド履歴・ファイルを取得
  - 2. Gemini APIへリクエスト (文脈・画像を渡す)
  - 3. 生成された回答で、先の「思考中です...」メッセージを更新
```

### 主要ファイル

| ファイル | 役割 |
| :--- | :--- |
| `Code.js` | 本体ロジック (Slackイベント受信、非同期処理、Gemini API連携、Slack投稿) |
| `appsscript.json` | Apps Scriptプロジェクト設定 (APIスコープ, WebApp権限など) |
| `deploy.sh` | clasp CLIを使ったデプロイスクリプトのサンプル |

---

## 📦 必要なもの

- Slackワークスペース (アプリを作成できる権限)
- Googleアカウント (Google Apps Script / Google Cloud Platform利用)
- Google Cloudプロジェクトと有効な課金アカウント
- `clasp` (ローカル環境からデプロイする場合)

---

## 🔑 設定手順

### 1. Google Cloud Platform (GCP) でAPIキーを準備

1.  **Google Cloudプロジェクトの選択または作成**: [Google Cloud Console](https://console.cloud.google.com/)
2.  **APIの有効化**: `APIとサービス` > `ライブラリ`で「**Generative Language API**」を検索し、有効化します。
3.  **APIキーの作成**: `APIとサービス` > `認証情報`でAPIキーを作成し、安全な場所に保管します。**（重要）** 本番環境では、キーにIPアドレス制限などをかけ、セキュリティを強化してください。

### 2. Slack アプリの作成と設定

1.  **新規アプリ作成**: [Slack API: Your Apps](https://api.slack.com/apps) で「From scratch」からアプリを作成します。
2.  **OAuth & Permissions**:
    - 「Bot Token Scopes」に以下のスコープを追加します。
      - `app_mentions:read` (Botへのメンションを読み取る)
      - `chat:write` (メッセージを投稿・更新する)
      - `channels:history` (パブリックチャンネルの履歴を読む)
      - `groups:history` (プライベートチャンネルの履歴を読む)
      - `im:history` (DMの履歴を読む)
      - `mpim:history` (グループDMの履歴を読む)
      - `files:read` (添付されたファイルを読む)
3.  **アプリのインストール**: 「Install to Workspace」をクリックし、Bot User OAuth Token (`xoxb-...`) を取得します。

### 3. Google Apps Script プロジェクトの準備

1.  **リポジトリの準備**: `git clone`するか、このリポジトリのファイルを元に新しいApps Scriptプロジェクトを作成します。
2.  **claspの利用 (推奨)**:
    ```bash
    # claspをインストール
    npm install -g @google/clasp
    # Googleアカウントにログイン
    clasp login
    # 新規プロジェクトとして作成
    clasp create --type webapp --title "Slack Gemini Q&A Bot" --rootDir ./
    # または既存のプロジェクトに紐付け
    # clasp clone <scriptId>
    ```
3.  **スクリプトプロパティの設定**:
    - Apps Scriptエディタの `プロジェクト設定` > `スクリプト プロパティ` を開きます。
    - 以下の2つのプロパティを追加します。
      | キー | 値 |
      | :--- | :--- |
      | `GEMINI_API_KEY` | GCPで取得したAPIキー |
      | `SLACK_BOT_TOKEN` | Slackから取得したBotトークン (`xoxb-...`) |
4.  **デプロイ**:
    ```bash
    # clasp経由でデプロイ
    clasp push
    clasp deploy
    ```
    - デプロイ後、WebアプリのURL (`https://script.google.com/macros/s/.../exec`) が発行されます。

### 4. SlackとGASを接続

1.  Slackアプリ管理画面の「**Event Subscriptions**」を有効化します。
2.  「Request URL」に、上記で取得したApps ScriptのWebアプリURLを貼り付けます。URLが検証されればOKです。
3.  「Subscribe to bot events」で以下のイベントを購読します。
    - `app_mention`
    - `message.channels`
    - `message.groups`
    - `message.im`
    - `message.mpim`

これで全ての準備が完了です。SlackチャンネルにBotを招待し、メンションして話しかけてみてください。

---

## ⚙️ カスタマイズ

| 目的 | 対応箇所 |
| :--- | :--- |
| プロンプト（Botの人格）調整 | `getGeminiResponse`関数内の`systemInstruction`文字列 |
| 読み込む会話履歴の件数変更 | `getThreadHistory`関数内の`limit=10`の数値を変更 |
| 回答の最大文字数（トークン）変更 | `getGeminiResponse`関数内の`max_output_tokens`の数値を変更 |
| モデル変更 | `GEMINI_API_URL`定数のモデル名部分 (`gemini-2.5-flash`) を変更 |
| 重複チェックのキャッシュ時間変更 | `DUP_EVENT_CACHE_TTL`定数の数値を変更（秒単位） |

---

## 🚨 トラブルシューティング

| 症状 | 確認ポイント |
| :--- | :--- |
| Slack側でRequest URLの検証に失敗 | デプロイURLは正しいか？ 少し時間をあけてみる、Slackのページをリロードする等 |
| 「思考中です...」から応答が変わらない | ・GASの実行ログで`triggeredGeminiHandler`がエラーになっていないか？<br>・トリガーが作成されているか？<br>・Gemini APIキーは正しいか？ |
| 権限エラー (Authorization error) | ・Slack Bot Tokenは正しいか？<br>・必要なスコープが全て設定されているか？<br>・スコープ変更後にアプリを再インストールしたか？ |

---

## 📄 ライセンス

This project is released under the  Apache License.
