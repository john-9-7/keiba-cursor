# netkeiba からのレース結果取得

## 概要

蓄積したスナップショット（予想時点のデータ）に対し、**netkeiba**（race.netkeiba.com / db.netkeiba.com）から**着順（1〜3着馬番・全着順）**と**払戻金**を自動取得し `results.jsonl` に追記する機能です。

### 払戻のデータ形式（`results.jsonl` の `payouts`）

結果ページの **`table.Payout_Detail_Table`**（`tr.Tansho` / `Fukusho` / `Wakuren` / `Umaren` / `Wide` / `Umatan` / `Fuku3` / `Tan3`）をパースします。

| キー | 内容 |
|------|------|
| `tansho` | 単勝 `{ key: 馬番, payout }` |
| `fukusho` | 複勝（頭ごと） |
| `wakuren` | 枠連 `key` は枠番の小さい順 `"6-7"` |
| `umaren` / `wide` / `umatan` / `sanrenpuku` / `sanrentan` | 既存と同じ（馬連は昇順キー、馬単・3連単は `>` 順） |

集計画面の回収率は従来どおり **馬連・ワイド・馬単・3連複・3連単** を使用します。単勝・複勝・枠連は JSON に保存され、将来の拡張やエクスポート用です。

古い HTML（`PayBack_Table` のみ）向けのフォールバックも残しています。

## 使い方

1. **`/accumulate-view.html`** を開く
2. **「結果を自動取得（netkeiba）」**パネルで**対象日**を選択
3. **「結果を自動取得」**ボタンを押す
4. 指定日の蓄積スナップショットのうち、**結果未登録**のレースについて netkeiba へアクセスし、着順を取得して追記

## API

```
POST /api/accumulate/fetch-results
Content-Type: application/json

{ "date": "2026-03-15" }
```

レスポンス例:

```json
{
  "ok": true,
  "date": "2026-03-15",
  "fetched": 24,
  "skipped": 12,
  "failed": 0,
  "accumulator": { "snapshotsCount": 36, "resultsCount": 36 }
}
```

## 対象

- **中央競馬**の JRA 開催（中山・中京・阪神・東京・京都・新潟・福島・札幌・函館・小倉）
- 蓄積スナップショットに `meetingDate`・`venue`・`raceIndex` が含まれるレース
- 結果が **netkeiba に掲載済み**のレース（レース直後は反映に時間がかかることがあります）

## 技術仕様

- **取得元**: db.netkeiba.com（レース一覧）→ race.netkeiba.com（結果ページ）
- **リトライ**: 5xx・429 時は自動で再試行
- **遅延**: リクエスト間に 600〜800ms 程度の待機（サーバー負荷軽減）
- **同時取得数**: 環境変数 `FETCH_RESULTS_CONCURRENCY`（既定 2、1〜4）で調整

## 注意

- **netkeiba の利用規約**を確認のうえご利用ください。過度なアクセスは避けてください。
- 取得したデータは**主催者発表と照合**することを推奨します（netkeiba の表示にも記載あり）。
