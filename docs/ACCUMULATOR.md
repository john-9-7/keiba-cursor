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

- **`/accumulate-view.html`** … 蓄積の**一覧（結果突合）**・**着順の入力**・**CSVダウンロード**・**RPT別の簡易集計**（直近最大500件ベース）。

## API

- `GET /api/accumulate/status` … 件数とサーバー上の絶対パス
- `GET /api/accumulate/recent?limit=50` … `snapshots.jsonl` 末尾 N 件（生データ）
- `GET /api/accumulate/merged?limit=100` … 末尾 N 件のスナップショットに `results.jsonl` を `race_id` で突合した配列
- `GET /api/accumulate/stats?limit=300` … 上記と同様の範囲で **RPT別件数・買い/見送り・結果紐づき・「BB最高馬が1着」** などの集計
- `POST /api/accumulate/bulk-venue` … `date`, `venue`, `cookie`（省略可＝保存済み）, `cookiePurpose`（省略時は `archive`）
- `POST /api/accumulate/save-race` … 1レースだけ `raceId` で取得して追記
- `POST /api/accumulate/result` … `raceId` + 着順などを `results.jsonl` に追記（同一 `race_id` で複数行ある場合、突合では **recordedAt が最新**の行を使用）

## クラウド（Render 等）について

無料Webサービスではディスクが**再起動で消える**ことが多いです。長期保管は **ファイルのダウンロード**、または将来 **PostgreSQL** への移行を検討してください。

## 分析の進め方（例）

1. 過去開催を表示できる Cookie で `bulk-venue` を回し、会場12R分を `snapshots.jsonl` に溜める。
2. レース後、**`/accumulate-view.html`** で `race_id` と1〜3着を入力する（または `POST /api/accumulate/result`）。
3. 同ページの**集計**・**CSV**で RPT 別の傾向を確認する。さらに深い分析は CSV を Excel 等へ。

（サイトの利用規約・スクレイピング可否は各自でご確認ください。）
