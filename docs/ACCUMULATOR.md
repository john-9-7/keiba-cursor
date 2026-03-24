# データ蓄積（分析用）

## 保存先（本番・ローカル共通のパス）

ツールが動いているマシン（**本番のコンテナ**または **手元PC**）上の、次のパスに保存されます。

| ファイル | 内容 |
|---------|------|
| `data/accumulated/snapshots.jsonl` | 取得時点の **race_id・会場・日付・RPT・馬柱（BB/オッズ）・判定（judgment）** など。1行 = 1レース（追記のみ）。 |
| `data/accumulated/results.jsonl` | 任意。**着順・3着以内**などを後から記録し、`race_id` でスナップショットと突合します。 |

- **本番**では `GET /api/accumulate/status` のレスポンスに **サーバー上の絶対パス** が含まれます（直接ファイルを触れない場合は API や将来のエクスポートで対応）。
- リポジトリ内では `.jsonl` は `.gitignore` 対象です。バックアップは **フォルダごとコピー** またはホスティングの永続化機能を利用してください。

## 画面（フェーズ1〜2）

- **`/accumulate-view.html`** … 蓄積の**一覧（結果突合）**・**着順の入力**・**結果の自動取得（netkeiba）**・**1〜3着馬のBB指数順位（そのレース内の競技順位）**・**CSV**・**RPT別集計**・**BB順位のヒストグラム**（直近最大500件ベース）。

### 重複しない取り込み

- スナップショットは **`race_id` が既に `snapshots.jsonl` に存在する場合は追記しません**（再一括・再実行しても二重になりにくい）。
- 判定はサーバープロセス内のメモリキャッシュ＋追記時更新。ファイルを手で編集した場合はキャッシュと実ファイルがずれることがある（そのときはサーバー再起動で再読込）。

### BB順位の意味

- 各レースの**蓄積時点の出馬表**のBB指数で、**競技順位**（同値は同順位・次は飛ぶ）を付け、実際の1・2・3着馬番が**何位だったか**を表示・集計します。
- 将来「BB1位が1着になる率」などにそのまま拡張できます（CSVの `firstBbRank` 列でも集計可能）。

## API

- `GET /api/accumulate/status` … 件数とサーバー上の絶対パス
- `GET /api/accumulate/recent?limit=50` … `snapshots.jsonl` 末尾 N 件（生データ）
- `GET /api/accumulate/merged?limit=100` … 末尾 N 件のスナップショットに `results.jsonl` を `race_id` で突合した配列
- `GET /api/accumulate/stats?limit=300` … 上記と同様の範囲で **RPT別件数・買い/見送り・結果紐づき・「BB最高馬が1着」** などの集計
- `POST /api/accumulate/bulk-venue` … `date`, `venue`, `cookie`（省略可＝保存済み）, `cookiePurpose`（省略時は `archive`）
- `POST /api/accumulate/bulk-all-list` … レース一覧HTMLから **日付×会場のすべて** を順に蓄積（各会場の全レース）。`date` を省略すると一覧に出ている開催すべて。`date` を指定するとその日付の会場だけ。**処理が長い**ためホスティングの **HTTP タイムアウト**に注意
- `POST /api/accumulate/save-race` … 1レースだけ `raceId` で取得して追記
- `POST /api/accumulate/result` … `raceId` + 着順などを `results.jsonl` に追記（同一 `race_id` で複数行ある場合、突合では **recordedAt が最新**の行を使用）
- `POST /api/accumulate/fetch-results` … 指定日の蓄積スナップショットについて、**未登録レース**の結果を **netkeiba** から取得し `results.jsonl` に追記。Body: `{ "date": "2026-03-15" }`。中央競馬（中山・中京・阪神など）のみ対応。同時取得数は `FETCH_RESULTS_CONCURRENCY`（既定2）で調整可。
- `POST /api/accumulate/backfill-payouts` … 指定日の既存結果のうち **払戻が空のレースだけ** を再取得して追記（バックフィル）。Body: `{ "date": "2026-03-15" }`。
- `POST /api/accumulate/backfill-payouts-range` … 期間指定で払戻バックフィルを日次実行。Body: `{ "startDate": "2026-03-01", "endDate": "2026-03-24" }`（最大120日）。

## クラウド（Render 等）について

無料Webサービスではディスクが**再起動で消える**ことが多いです。**スマホから本番URLで蓄積を見る**場合は、**永続ディスク**を付け、`KEIBA_DATA_DIR` をそのマウント先（例: `/var/keiba-data`）に設定してください。リポジトリの **`render.yaml`** に Blueprint 例があります。長期保管は **CSV / フォルダコピー**、または将来 **PostgreSQL** への移行を検討してください。

## 分析の進め方（例）

1. 過去開催を表示できる Cookie で `bulk-venue` を回し、会場12R分を `snapshots.jsonl` に溜める。
2. レース後、**`/accumulate-view.html`** で `race_id` と1〜3着を入力するか、**結果を自動取得**で netkeiba から一括取得（または `POST /api/accumulate/result` / `POST /api/accumulate/fetch-results`）。
3. 同ページの**集計**・**CSV**で RPT 別の傾向を確認する。さらに深い分析は CSV を Excel 等へ。

（サイトの利用規約・スクレイピング可否は各自でご確認ください。）
