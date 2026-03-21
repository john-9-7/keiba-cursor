# 競馬予想ツール

競馬クラスター（RPT・BB指数）を利用した予想の分析・判断および集計分析を行うツールです。

## ドキュメント

- **[操作手順（操作手順.md）](docs/操作手順.md)** … サーバーの意味・起動・Cookie取得・取得実行・再起動の手順（初心者向け）
- **[仕様書（SPEC.md）](docs/SPEC.md)** … 機能要件・判定ロジック・出力フォーマット・データソース等の定義
- **[次のステップ（NEXT_STEPS.md）](docs/NEXT_STEPS.md)** … 開発の進め方・おすすめの順番
- **[技術選定（TECH_STACK.md）](docs/TECH_STACK.md)** … 採用技術とプロジェクト構成
- **[スクレイピング技術仕様（SCRAPING_SPEC.md）](docs/SCRAPING_SPEC.md)** … 競馬クラスターのCookie・race-list/race-analyze の構造とパース仕様

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
6. Deploy 実行
7. 発行された `https://...onrender.com` にアクセスし、ID/パスワードでログインできることを確認

### 3) 運用時の注意

- `AUTH_PASS` は 20文字以上のランダム推奨
- 必ず `https://` のURLだけ使う
- パスワードは定期的に変更
- 公開URLを第三者に共有しない
