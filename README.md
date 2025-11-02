# AI Consultant Platform

AIパワード・ビジネスコンサルティングプラットフォーム - OpenAI Realtime APIを活用した音声対話型コンサルティングサービス

## 概要

このプロジェクトは、日本のビジネスコンサルタントとリアルタイムで音声対話ができるAIコンサルティングプラットフォームです。OpenAIのRealtime APIを統合し、自然な会話フローで専門的なビジネスアドバイスを提供します。

## 主な機能

### 🎙️ リアルタイム音声対話
- OpenAI Realtime APIによる低遅延音声会話
- Voice Activity Detection (VAD)による自然な会話フロー
- 自動音声認識とテキスト変換による会話履歴の保存

### 👥 5人の専門コンサルタント
- **五味田 匡功** - IT・テクノロジー専門家、スタートアップ経験豊富
- **佐藤 健一** - 製造業・B2B営業のエキスパート
- **山田 恵子** - 金融・保険業界のスペシャリスト
- **鈴木 大輔** - ヘルスケア・医療機器分野の専門家
- **高橋 麻衣** - 人事・タレントマネジメントコンサルタント

### 📊 構造化されたコンサルティングフロー
1. **質問フェーズ** - 初期情報収集
2. **ホットリーディング** - 即座の分析と洞察
3. **コールドリーディング** - 深い専門知識と業界知見
4. **補助金提案** - 政府補助金・支援制度の推奨
5. **サマリー** - 会話の要約とキーポイント
6. **推奨事項** - 実行可能な次のステップとネットワーキング機会

## 技術スタック

### フロントエンド
- React 18.3.1 + TypeScript
- Vite (ビルドツール)
- Tailwind CSS
- React Router DOM

### バックエンド・サービス
- Node.js/Express (トークン管理サーバー)
- OpenAI Realtime API
- WebRTC (リアルタイム音声ストリーミング)
- Web Audio API

## セットアップ

### 前提条件
- Node.js 18.x以上
- npm または yarn
- OpenAI APIキー

### インストール

```bash
# 依存関係のインストール
npm install

# 環境変数の設定
cp .env.example .env
# .envファイルにOpenAI APIキーを設定
```

### 開発環境の起動

```bash
npm run dev:full
```

アプリケーションは http://localhost:5173 で起動します。

### ビルド

```bash
npm run build
```

## プロジェクト構造

```
├── src/
│   ├── pages/              # ページコンポーネント
│   ├── services/           # API・WebRTC統合
│   ├── hooks/              # カスタムReactフック
│   ├── components/         # 再利用可能なUIコンポーネント
│   └── data/               # コンサルタントデータ・モックデータ
├── server/
│   └── tokenService.js     # OpenAIトークン管理サーバー
├── .kiro/specs/            # 技術仕様書
└── public/
    └── *.wav               # フォールバック音声ファイル
```

## 開発ガイドライン

このプロジェクトは**Kiroスタイルのスペック駆動開発**を採用しています。詳細は`CLAUDE.md`を参照してください。

### 主要なコマンド

- `/kiro:spec-status` - 現在の開発進捗を確認
- `/kiro:steering` - プロジェクトステアリング文書の更新
- `npm run lint` - コードのリント
- `npm run typecheck` - TypeScriptの型チェック

### ID/PASS
ID：admin@example.com
PASS：admin

## ライセンス

[ライセンス情報を追加してください]

## 貢献

[貢献ガイドラインを追加してください]

## サポート

問題や質問がある場合は、GitHubのIssuesをご利用ください。