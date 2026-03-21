# 技術選定

## 採用技術（骨組み）

| 役割 | 技術 | 理由 |
|------|------|------|
| ランタイム | **Node.js** (LTS) | Windowsでそのまま動かしやすい。HTTPリクエストやファイル操作が簡単。 |
| バックエンド | **Express** | 軽量で、APIと静的ファイル配信を1つで扱える。 |
| フロント | **HTML + CSS + 素のJavaScript** | ビルド不要で、Cookie入力・結果表示までをまず実装。必要になったらReact等に拡張可能。 |
| HTTP（Cookie付き取得） | **Node.js 標準の fetch** | Node 18以降で使える。Cookieヘッダを付けてリクエストするだけなので十分。 |

## プロジェクト構成（現時点）

```
keiba-cursor/
├── docs/           … 仕様書・設計メモ
├── public/         … ブラウザに配信するHTML/CSS/JS
│   └── index.html
├── server.js       … Expressサーバー（API + 静的配信）
├── package.json
├── .gitignore
└── README.md
```

## 今後の拡張候補

- パース処理の追加（取得HTMLから馬番・RPT・BB指数・オッズを抜き出す）
- 判定ロジックの実装（仕様書のパターンA〜D）
- データ保存（JSONファイルやSQLiteなど）
- フロントをReact/Vueにする（画面が複雑になった場合）
