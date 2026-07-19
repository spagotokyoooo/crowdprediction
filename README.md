# SPAGO 周辺情報

SPAGO 原宿へ、天気予報と近隣主要施設のイベント状況をLINEで送る運用者向けMVPです。

LINEの認証情報がなくても画面と判定ロジックを確認できるMVPです。画面内のイベント追加、日付切替、予報フィードバックはブラウザ上で動作します。

## 起動

```bash
npm run dev
```

ブラウザで `http://localhost:4173` を開きます。

## 現在の実装範囲

- 毎朝の当日天気予報と近隣主要施設のイベント状況のLINE通知
- Open-Meteo Forecast APIから取得するSPAGO周辺の時間別天気予報
- 東京体育館、明治神宮野球場、代々木競技場、国立競技場、WITH HARAJUKU HALLの公式情報モニター
- イベントを自動取得できない施設は「公式情報を確認中」と明示する安全策
- LINE通知文のプレビュー
- 手動イベント登録のデモ
- LINE Webhookの署名検証、重複イベント抑止、「今日／明日／今週／来週」への応答
- スケジューラから呼べる朝の周辺情報通知エンドポイント

## 次に接続するもの

1. 会場ごとのイベント時刻・規模取得アダプターの強化
2. 予報・イベント・フィードバックを保存するデータベース

## LINEを有効化する

1. `.env.example` を `.env` としてコピーし、LINE Developers Consoleの値を設定する。
2. 本番の公開URLに `/webhook/line` を付け、LINEのWebhook URLに登録する。
3. `LINE_DESTINATION_ID` を空欄にすると、友だち追加している全員へブロードキャスト通知します。特定のグループ・個人だけに送る場合はIDを設定してください。
4. ホスティング側のスケジューラから、毎朝8:00（Asia/Tokyo）に `POST /api/jobs/morning` を呼ぶ。リクエストには `Authorization: Bearer {CRON_SECRET}` を付ける。

ローカルで通知文だけ確認する場合は `GET /api/line/preview`、今週版は `GET /api/line/preview?period=week`、来週版は `GET /api/line/preview?period=next-week` を利用できます。実際のLINE送信は、アクセストークンと通知先IDを設定するまで実行されません。

実装方針と運用ルールは [PLAN.md](./PLAN.md) を参照してください。
