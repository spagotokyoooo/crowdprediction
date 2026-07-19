# SPAGO 周辺情報

SPAGO 原宿へ、天気予報と近隣主要施設のイベント状況をLINEで送る運用者向けMVPです。

LINEの認証情報がなくても画面と判定ロジックを確認できるMVPです。画面内のイベント追加、日付切替、予報フィードバックはブラウザ上で動作します。

## 起動

```bash
npm run dev
```

ブラウザで `http://localhost:4173` を開きます。

## 現在の実装範囲

- 日曜朝に翌週（月〜土）の周辺情報、月〜金の朝に当日情報、月〜金の夜に翌日情報を送るLINE通知
- Open-Meteo Forecast APIから取得するSPAGO周辺の時間別天気予報
- 東京体育館、明治神宮野球場、代々木競技場、国立競技場、WITH HARAJUKU HALLの公式イベント情報を自動取得
- LINE通知文のプレビュー
- 手動イベント登録のデモ
- LINE Webhookの署名検証、重複イベント抑止、「今日／明日／今週／来週」への応答（週次は月曜から順に、イベント・荒天だけを短く補足）
- スケジューラから呼べる朝・夜の周辺情報通知エンドポイント

## 次に接続するもの

1. 会場ごとのイベント時刻・規模取得アダプターの強化
2. 予報・イベント・フィードバックを保存するデータベース

## LINEを有効化する

1. `.env.example` を `.env` としてコピーし、LINE Developers Consoleの値を設定する。
2. 本番の公開URLに `/webhook/line` を付け、LINEのWebhook URLに登録する。
3. `LINE_DESTINATION_ID` を空欄にすると、友だち追加している全員へブロードキャスト通知します。特定のグループ・個人だけに送る場合はIDを設定してください。
4. ホスティング側のスケジューラに以下を登録する。いずれも `Authorization: Bearer {CRON_SECRET}` を付けてPOSTする。

   | JST | 曜日 | エンドポイント | 送信内容 |
   | --- | --- | --- | --- |
   | 8:00 | 日曜 | `/api/jobs/morning` | 翌週（月〜土） |
   | 8:00 | 月〜金 | `/api/jobs/morning` | 当日 |
   | 20:00 | 月〜金 | `/api/jobs/evening` | 翌日 |

   スケジューラがUTC指定の場合は、それぞれ `0 23 * * 6`、`0 23 * * 0-4`、`0 11 * * 1-5` を使う。

ローカルで通知文だけ確認する場合は `GET /api/line/preview`、今週版は `GET /api/line/preview?period=week`、来週版は `GET /api/line/preview?period=next-week` を利用できます。実際のLINE送信は、アクセストークンと通知先IDを設定するまで実行されません。

実装方針と運用ルールは [PLAN.md](./PLAN.md) を参照してください。
