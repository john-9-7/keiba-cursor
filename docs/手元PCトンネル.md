# 手元PCで動かしてスマホから開く（無料・蓄積が消えない）

Render の無料サービスは **再デプロイでデータが消える**ことがあります。  
**蓄積を消したくないとき**は、データを **自分のPCのフォルダ**に置いたまま、**インターネット経由でスマホから触る**方法が無料で確実です。

---

## 全体の流れ（3ステップ）

1. **PC**でこのツールを起動する（`npm start`）  
2. **トンネル**という無料ソフトで、`localhost:3000` を **https のURL** に一時的に公開する  
3. **スマホのブラウザ**で、その https のURLを開く  

蓄積データは **PC上の `data/accumulated/`** に入ります。デプロイの影響は受けません。

---

## 事前準備（初回だけ）

1. **Node.js** を入れる（未導入なら [https://nodejs.org/](https://nodejs.org/) の LTS）。  
2. **プロジェクトフォルダ**で PowerShell を開き、次を実行する。

   ```powershell
   cd C:\Users\jochi\keiba-cursor
   npm install
   ```

3. （初回だけ）Playwright を使う機能がある場合:

   ```powershell
   npx playwright install chromium
   ```

---

## ステップ1：ツールをPCで起動

PowerShell で:

```powershell
cd C:\Users\jochi\keiba-cursor
npm start
```

「listening」などで **ポート 3000** が出たらOKです。  
このウィンドウは **閉ばない**でください。閉じるとスマホからも繋がらなくなります。

**確認（PCのブラウザ）:**  
[http://localhost:3000](http://localhost:3000) が開ければ成功です。

---

## ステップ2：トンネルを用意する（どちらか1つ）

### A. Cloudflare Quick Tunnel（登録なしで試しやすい）

1. **cloudflared** を入れる（どちらか）。  
   - **winget:**  
     `winget install --id Cloudflare.cloudflared -e`  
   - 入らない場合は [Cloudflare の cloudflared 配布ページ](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) から Windows 用をダウンロードし、PATH の通った場所に置く。

2. **別の** PowerShell ウィンドウを開き、次を実行する（**npm start は動いたまま**）。

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

3. しばらくすると、画面に **`https://xxxx.trycloudflare.com`** のようなURLが表示されます。

**注意**

- このURLは **cloudflared を止めると無効**になります。次に起動すると **別のURL** になることが多いです。  
- スマホのホーム画面にブックマークしておくと便利です（**URLが変わったら更新**が必要）。

### B. ngrok（無料アカウントでよく使われる）

1. [https://ngrok.com/](https://ngrok.com/) で無料登録し、**Authtoken** を取得する。  
2. ngrok をインストールし、公式の手順で `ngrok config add-authtoken （あなたのトークン）` を実行。  
3. **npm start が動いている状態で**、別のターミナルから:

   ```powershell
   ngrok http 3000
   ```

4. 表示された **https の Forwarding URL** をスマホで開く。

（無料枠ではセッション時間などの制限があります。公式の説明を参照してください。）

---

## ステップ3：スマホで開く

1. スマホの **Chrome や Safari** で、ステップ2で出た **https のURL** を開く。  
2. トップ → **蓄積データの確認・結果入力** など、いつも使う画面へ進む。  
3. 上部の **スナップショット件数** が **0 でない**こと（データを溜めたあと）を確認する。

---

## よくあるつまずき

| 症状 | 試すこと |
|------|----------|
| スマホで開けない | PC の `npm start` と `cloudflared`（または ngrok）が **両方動いているか**。ファイアウォールがブロックしていないか。 |
| すぐ切れる | PCが **スリープ**していないか。画面を閉じてないか。 |
| ログインを求められる | `.env` や環境変数で **Basic認証**を付けている場合、PCで使っているID/パスワードをスマホでも入れる。 |
| URLが変わった | Quick Tunnel / 無料ngrok では **起動のたびにURLが変わる**ことがあります。新しいURLをスマホのブックマークに入れ直す。 |

---

## データのバックアップ（安心用）

- フォルダ **`data/accumulated/`** ごと、USB や OneDrive に **コピー**しておくと万が一のとき安心です。  
- `.jsonl` ファイルが **蓄積の本体**です。

---

## Render との使い分けの目安

| 使い方 | 蓄積が消えにくいか |
|--------|-------------------|
| **手元PC + トンネル** | データはPCに残るので **消えにくい**（PCの故障・フォルダ削除には注意） |
| **Render 無料URLだけ** | 再デプロイで **消えることがある**（CSVバックアップ推奨） |
