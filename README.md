# 競馬予想ツール

競馬クラスター（RPT・BB指数）を利用した予想の分析・判断および集計分析を行うツールです。

## ドキュメント

- **[操作手順（操作手順.md）](docs/操作手順.md)** … **本番サーバー**での使い方（URL・環境変数・取得・トラブル）。手元PCでの起動は付録に記載
- **[仕様書（SPEC.md）](docs/SPEC.md)** … 機能要件・判定ロジック・出力フォーマット・データソース等の定義
- **[プロジェクト1枚要約（PROJECT_ONE_PAGER.md）](docs/PROJECT_ONE_PAGER.md)** … 目的・運用フロー・優先順位を1枚で確認するための基準文書
- **[次のステップ（NEXT_STEPS.md）](docs/NEXT_STEPS.md)** … 開発の進め方・おすすめの順番
- **[技術選定（TECH_STACK.md）](docs/TECH_STACK.md)** … 採用技術とプロジェクト構成
- **[スクレイピング技術仕様（SCRAPING_SPEC.md）](docs/SCRAPING_SPEC.md)** … 競馬クラスターのCookie・race-list/race-analyze の構造とパース仕様
- **[データ蓄積（ACCUMULATOR.md）](docs/ACCUMULATOR.md)** … `data/accumulated/` の JSONL、API、**`/accumulate-view.html`**（一覧・結果入力・**結果の自動取得（netkeiba）**・CSV・集計）
- **[netkeiba 結果取得（NETKEIBA_RESULTS.md）](docs/NETKEIBA_RESULTS.md)** … 着順の自動取得の使い方・API・注意事項
- **[直前オッズで再判定（ODDS_REJUDGE.md）](docs/ODDS_REJUDGE.md)** … RPT・BB キャッシュ ＋ テキスト入力オッズで再判定
- **[取得の安定性（NETWORK_FETCH.md）](docs/NETWORK_FETCH.md)** … `race-analyze` 取得の共通化・リトライ・`DASHBOARD_FETCH_CONCURRENCY`

## 主な機能（予定）

1. **分析・判断** … 競馬クラスターのデータを取得し、RPT別のルールで買い目・見送りを判定
2. **集計分析** … RPT別・BB指数範囲別の好走状況を集計し、条件の見直しに利用
3. **レース結果の取得・反映** … Webからレース結果を取得し、集計・検証に利用

## 技術・環境

- Windows（PC）・iPhone で利用可能な Web アプリ（または PWA）を想定
- 骨組み: Node.js + Express、フロントは HTML/CSS/JS（[技術選定](docs/TECH_STACK.md)）

## 起動方法

1. **Node.js をインストール**（未導入の場合）  
   [https://nodejs.org/](https://nodejs.org/) から LTS 版をダウンロードしてインストール。

2. **依存関係のインストール**（初回のみ）
   ```bash
   npm install
   ```
   「ブラウザで取得」を使う場合は、さらに Chromium をインストール（初回のみ）：
   ```bash
   npx playwright install chromium
   ```

3. **サーバーを起動**
   ```bash
   npm start
   ```

4. **ブラウザで開く**  
   [http://localhost:3000](http://localhost:3000) にアクセスする。

5. **データ取得の流れ（B案）**
   - ブラウザで [競馬クラスター](https://web.keibacluster.com/top) にログイン（中央競馬を選び、その日のPWで認証）。
   - 会場・レースを選んでデータページ（出馬表）を表示し、**アドレスバーのURL**（`race-analyze-next`）をコピー。
   - 開発者ツール（F12）などで **Cookie**（laravel_session と XSRF-TOKEN）をコピー。
   - 本ツールの画面で Cookie と URL を貼り付けて「取得」を押す。
   - **トップページが返る場合**は、画面の「**ブラウザで取得**」にチェックを入れてから再度「取得」を押す（Playwright で実ブラウザから取得します）。

## テスト（回帰・スモーク）

1. **回帰テスト（ローカル、ネットワーク不要）**
   ```bash
   npm run test:regression
   ```
   - 一覧パース（`allRaces` 多重ブロック）  
   - ダッシュボードのレース選定  
   - 発走済み判定

2. **スモークテスト（デプロイ先疎通）**
   ```bash
   npm run test:smoke
   ```
   既定は `http://localhost:3000` を対象。Render 本番を確認する場合は例のように環境変数を付けて実行します。
   ```powershell
   $env:SMOKE_BASE_URL="https://keiba-cursor.onrender.com"
   $env:SMOKE_AUTH_USER="your_id"
   $env:SMOKE_AUTH_PASS="your_strong_password"
   $env:SMOKE_COOKIE_PURPOSE="live"
   npm run test:smoke
   ```
   - `SMOKE_COOKIE` 未指定時は、サーバー保存済みCookie（または `KEIBA_COOKIE` / `KEIBA_COOKIE_ARCHIVE`）を利用  
   - `SMOKE_COOKIE` 指定時は、その値を優先して疎通確認

3. **スモークテスト一括（live + archive）**
   ```bash
   npm run test:smoke:all
   ```
   - `live` → `archive` の順で `test:smoke` を連続実行します。  
   - 実行ログは既定で `logs/smoke-YYYYMMDD-HHMMSS.log` に保存されます。  
   - 同名で `logs/smoke-YYYYMMDD-HHMMSS.json` も生成され、モード別の機械可読サマリーを保存します。  
   - 失敗時はログ末尾に **mode別サマリー**（`summary=...`）と **stdout/stderr の末尾抜粋**を自動追記します。  
   - サマリーにはエラー種別タグ（`AUTH` / `NETWORK` / `TIMEOUT` / `HTTP_4XX` / `HTTP_5XX` / `SESSION`）を自動付与します。  
   - 片方だけ実行したい場合:
   ```powershell
   $env:SMOKE_ALL_MODES="live"
   npm run test:smoke:all
   ```
   - ログ保存先を変える場合:
   ```powershell
   $env:SMOKE_LOG_DIR="tmp/smoke-logs"
   npm run test:smoke:all
   ```

4. **スモーク結果レポート（最新JSONを要約）**
   ```bash
   npm run test:smoke:report
   ```
   - 最新の `logs/smoke-*.json` を読み、失敗モードの次アクションを1行で表示します。  
   - 特定のJSONを読む場合:
   ```powershell
   $env:SMOKE_REPORT_FILE="logs/smoke-20260324-012415.json"
   npm run test:smoke:report
   ```

5. **ゲート一括（回帰 → smoke-all → report）**
   ```bash
   npm run test:gate
   ```
   - デプロイ直前チェック用のワンコマンドです。  
   - 途中で失敗した時点で終了します。

## 自分専用で公開する（認証つき）

最短で安全に公開するには、`ENABLE_AUTH=true` で Basic 認証を有効化してからクラウドにデプロイします。

### 1) ローカルで認証を試す

1. `C:\Users\jochi\keiba-cursor\.env.example` を参考に、PowerShell で環境変数を設定
   ```powershell
   $env:ENABLE_AUTH="true"
   $env:AUTH_USER="your_id"
   $env:AUTH_PASS="your_strong_password"
   npm start
   ```
2. `http://localhost:3000` を開く
3. ID/パスワード入力ダイアログが出ればOK

### 2) Render に公開（おすすめ）

1. GitHub にこのプロジェクトを push
2. Render で「New +」→「Web Service」
3. GitHub リポジトリを選択
4. 設定を入力
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Environment Variables を設定
   - `ENABLE_AUTH=true`
   - `AUTH_USER=あなた専用ID`
   - `AUTH_PASS=長く強いパスワード`
   - （任意・iPhoneで毎回Cookieを貼りたくない場合）`KEIBA_COOKIE` … **今日・リアルタイム用**のセッションを1行で貼り付け
   - （任意）`KEIBA_COOKIE_ARCHIVE` … **過去開催・DB取り込み用**の別セッション。画面の「過去・DB用」と対応
6. Deploy 実行
7. 発行された `https://...onrender.com` にアクセスし、ID/パスワードでログインできることを確認

### 3) 運用時の注意

- `AUTH_PASS` は 20文字以上のランダム推奨
- 必ず `https://` のURLだけ使う
- パスワードは定期的に変更
- 公開URLを第三者に共有しない

## iPhone だけで使う（Cookieを毎回貼らない）

競馬クラスターの Cookie は iPhone の Safari からは取りにくいため、次のどちらかを使います。

1. **PCで一度「サーバーに Cookie を保存」**  
   ツール画面のボタンで保存 → iPhone では **「保存済みの Cookie を使う」にチェック**し、Cookie 欄は空のまま取得。

2. **Render の環境変数 `KEIBA_COOKIE`（おすすめ）**  
   PCでコピーした Cookie を Render の Environment に貼る。再デプロイ後も残り、**iPhone はチェックだけで完結**しやすいです。  
   ※ Cookie の有効期限が切れたら、PCで取り直して `KEIBA_COOKIE` を更新してください。

※ Render の無料枠ではサーバー内ファイルは再起動で消えることがあるため、**本番は `KEIBA_COOKIE` 併用**を推奨します。
