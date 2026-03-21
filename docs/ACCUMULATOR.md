# データ蓄積（分析用）

## 保存先（本番・ローカル共通のパス）

ツールが動いているマシン（**本番のコンテナ**または **手元PC**）上の、次のパスに保存されます。

| ファイル | 内容 |
|---------|------|
| `data/accumulated/snapshots.jsonl` | 取得時点の **race_id・会場・日付・RPT・馬柱（BB/オッズ）・判定（judgment）** など。1行 = 1レース（追記のみ）。 |
| `data/accumulated/results.jsonl` | 任意。**着順・3着以内**などを後から記録し、`race_id` でスナップショットと突合します。 |

- **本番**では `GET /api/accumulate/status` のレスポンスに **サーバー上の絶対パス** が含まれます（直接ファイルを触れない場合は API や将来のエクスポートで対応）。
- リポジトリ内では `.jsonl` は `.gitignore` 対象です。バックアップは **フォルダごとコピー** またはホスティングの永続化機能を利用してください。

## API

- `GET /api/accumulate/status` … 件数とサーバー上の絶対パス
- `POST /api/accumulate/bulk-venue` … `date`, `venue`, `cookie`（省略可＝保存済み）, `cookiePurpose`（省略時は `archive`）
- `POST /api/accumulate/save-race` … 1レースだけ `raceId` で取得して追記
- `POST /api/accumulate/result` … `raceId` + 着順などを `results.jsonl` に追記

## クラウド（Render 等）について

無料Webサービスではディスクが**再起動で消える**ことが多いです。長期保管は **ファイルのダウンロード**、または将来 **PostgreSQL** への移行を検討してください。

## 分析の進め方（例）

1. 過去開催を表示できる Cookie で `bulk-venue` を回し、会場12R分を `snapshots.jsonl` に溜める。
2. レース後、公式結果や自分のメモから `POST /api/accumulate/result` で `race_id` 単位に結果を足す（またはスプレッドシートで管理して後で結合）。
3. Excel / Python / Node で JSONL を読み、`rpt`・`judgment.verdict` などと着順を突合して「狙い／見送り」の傾向を集計する。

（サイトの利用規約・スクレイピング可否は各自でご確認ください。）
