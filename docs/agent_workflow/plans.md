# Agent Phase Switching Implementation Plan

## 1. 背景と目的
- 会話の進行に合わせてシステムプロンプトを動的に切り替えることで、エージェントの役割を明確化し、回答品質と一貫性を高める。
- 4フェーズ（①開始・深掘り、②モード確認、③コンサル、④サマリー）を状態機械として管理し、各フェーズに最適化されたプロンプトと挙動を実装する。

## 2. フェーズ定義とプロンプト方針
- **開始・深掘り**: ユーザーの課題抽出と情報収集にフォーカス。仮説構築、質問ドリルを行う。
- **モード確認**: 収集した情報のまとめと、ユーザー意図・優先度・制約条件の再確認。次フェーズへの合意形成。
- **コンサル**: 分析・提案・意思決定支援。フレームワーク適用と実行可能な示唆の提示。
- **サマリー**: 成果物の整理、次のアクション、フォローアップ項目の明示。必要に応じてログ保存やユーザー通知。

各フェーズに対してテンプレート化されたシステムプロンプトを `config/prompts/{phase}.md` などに分離して管理し、バージョン管理を容易にする。

## 3. フェーズ遷移判定ロジック
### 3.1 基本構造
- 単純な線形状態機械（開始 → 確認 → コンサル → サマリ―）をベースにしつつ、明示的なユーザー操作での後戻り（例: 追加深掘りリクエスト）を許容。
- `PhaseManager` クラス（フロント or サーバーサイド）で現在フェーズ、候補フェーズ、遷移履歴を保持。
- すべての遷移は PhaseManager が候補フェーズを提示し、ユーザー承認（音声確認を基本とし、必要に応じて簡易 UI を補助的に利用）を得てから確定する。

### 3.2 遷移トリガー候補
1. **明示的トリガー**: UIのフェーズ選択、スラッシュコマンド、特定キー入力で即時切替。
2. **会話内容解析トリガー**: 
   - メッセージを LLM 分類器（少ショットプロンプト）に渡し、ユーザー／エージェントの発話意図を判定。
   - 例: 「では提案をください」→ コンサル開始、 「まとめてください」→ サマリーなど。
3. **進行状況メトリクス**:
   - 質問数、回答数、深掘り度（エンティティ抽出やスコアリング）、モード確認のチェックリスト達成率で閾値判定。
4. **時間・沈黙**: 一定時間質問が来ない場合に終話候補としてサマリーへ移行を提案。

### 3.3 判定方式の推奨
- **フェーズごとチェックリスト**: 
  - 開始フェーズ完了条件: (a) 課題仮説の提示, (b) 不明点リスト化, (c) 確認質問完了。
  - モード確認完了条件: ユーザーの優先度確認、最終確認の「Yes」。
  - コンサル完了条件: ソリューション提示＋懸念事項整理。
- **会話解析器（LLM or ルールベース）**を導入し、チェックリストの達成有無を判定するスコアを出す。閾値超過時に「次フェーズ候補」を PhaseManager に通知。
- 可能なら LLM 判定とルールベースを組み合わせた Ensembling（両者一致で候補フェーズを提示し、最終的にはユーザー承認を取得）。
- 自動判定はいったん「推奨」として提示し、音声でのユーザー承認／却下を受け付け、必要に応じて簡易 UI（ボタンなど）による応答も許容する。
- 音声確認プロンプト例: 「次のフェーズに移行していいですか？」 / 想定応答: 「はい」「いいえ」などの単語レベルの返答。

## 4. 実装ステップ
1. **調査・設計**  
   - 現行プロンプトと会話ログをレビューし、各フェーズに必要な情報を整理。  
   - 状態機械と PhaseManager のインターフェイス仕様を策定（メソッド: `getCurrentPhase`, `requestTransition`, `confirmTransition`, `applyPrompt` 等）。
2. **プロンプト分割と管理**  
   - 既存プロンプトをフェーズ別テンプレートに分割、メタデータ（バージョン、トーン設定、入力変数）を定義。  
   - テンプレート管理モジュール（例: `PromptStore`）を実装。
3. **遷移判定モジュール開発**  
   - 明示トリガー: フロント/UIと連携し、ユーザー操作を PhaseManager に通知。  
   - ルールベース分析: 既存会話ログからトリガーフレーズ、質問数、ステップ完了などのルールを実装。  
   - LLMベース分類器（最初はサーバー側推論 or OpenAI function call）をプロトタイプ。性能確認後、必要なら軽量化（few-shot prompt）を検討。
4. **エージェント制御統合**  
   - PhaseManager をエージェントのリクエスト処理フローに組み込み。  
   - 各フェーズ遷移時に該当プロンプトを設定し直すフックを実装。  
   - OpenAI Realtime API を活用し、遷移推奨時に音声プロンプトで承認確認を行い、同一セッション内で応答解析を実施して遷移を確定。
5. **テスティング & チューニング**  
   - ユニット: PhaseManager の状態遷移テスト。  
   - 統合: ダミー会話ログで遷移シミュレーション。  
   - ユーザーテスト: 実対話で閾値調整、誤判定時の人手介入フローを確認。
6. **リリース準備**  
   - ドキュメント更新（README, プロンプト仕様, オペレーション手順）。  
   - チーム向けハンドオフ & 運用ツール（フェーズ切替履歴ビュー）構築を検討。

## 5. 計測と運用
- ログ: 現フェーズでは必須とせず、将来的な精度改善のタイミングで詳細設計を検討。
- KPI: 遷移精度、ユーザー満足度、サマリーまでの平均ターン数、アサイン時間。
- 省力化: 後日、会話ログを活用した学習データ収集→判定モデル高度化を検討。

## 6. 未決事項・要検討
- LLM 判定を行う場合のコストとレイテンシ許容範囲。
- PhaseManager の実装先（フロント vs サーバー or ハイブリッド）とリアルタイム同期方法。
- フェーズ間でのプロンプトコンテキスト共有範囲（前フェーズから何を持ち越すか）。
- ユーザーが任意にフェーズを飛ばしたい場合の UI/UX。
- 音声承認プロンプトの文言・トーンと、Realtime API セッション内での応答解析手順。
- 音声承認結果を PhaseManager に伝達するイベント仕様（Realtime API のデータチャンネル / サーバーイベントなど）。

## 7. ロールアウト案
- **Phase 0**: 手動でフェーズを切り替え、プロンプト効果を検証。
- **Phase 1**: ルールベース遷移と手動確認のハイブリッド。
- **Phase 2**: LLM 判定の自動遷移 + 例外時手動ハンドリング。
- **Phase 3**: 運用データを用いた ML モデルへの拡張（必要に応じて）。

## 8. 音声承認イベントフロー案
1. PhaseManager が次フェーズ候補を決定した時点で、サーバー経由で OpenAI Realtime API へ `response.create` イベントを送信し、音声合成メッセージに確認プロンプトをセットする。
2. Realtime セッションが音声出力（および必要ならテキスト表示）を行い、ユーザーに「次のフェーズに移行していいですか？」と問いかける。
3. ユーザーの返答音声は WebRTC ストリームとして Realtime API に送信され、自動でテキスト化された `conversation.item` としてサーバーに push される。
4. サーバー側の PhaseManager が該当 `conversation.item` を監視し、シンプルな yes/no 判定ロジック（例: 「はい」「いいえ」「まだ」などの語彙マッピング）で承認可否を解釈する。
5. 判定結果に応じて PhaseManager が `phase.transition.confirmed` または `phase.transition.declined` といった内部イベントを発火し、確定した場合はシステムプロンプトを切り替える。
6. 必要に応じてクライアントへハンドシェイクレスポンス（例: WebSocket 経由のステータス更新）を返し、UI 側でフェーズ表示を更新する。

## 9. Realtime API response.create ペイロード案
```json
{
  "type": "response.create",
  "response": {
    "modalities": ["audio", "text"],
    "instructions": "次のフェーズに移行していいですか？",
    "conversation": {
      "importance": "critical",
      "metadata": {
        "phase_candidate": "consult",
        "request_id": "${transitionId}"
      }
    },
    "audio": {
      "voice": "alloy",
      "format": "wav"
    },
    "text": {
      "format": "plain"
    }
  }
}
```
- `modalities`: 音声出力は必須、UI でも提示したい場合は text を併用。
- `instructions`: 質問文をそのまま指定。後続でバリエーションを出したい場合はテンプレート化。
- `conversation.metadata`: PhaseManager が復帰時に識別できるよう候補フェーズや遷移 ID を埋め込む。
- `audio`: 使用する音声モデル（例: alloy）。
- `text`: テキスト提示する場合のフォーマット指定。

## 10. 承認応答解析ロジック（yes/no）
- WebRTC 経由で取得した `conversation.item` の `transcript` を対象に、以下の簡易判定を行う。
```javascript
const YES_TOKENS = ["はい", "うん", "ok", "承認", "お願いします"];
const NO_TOKENS = ["いいえ", "いや", "ノー", "保留", "まだ"];

function resolveApproval(transcript, confidence) {
  if (confidence < 0.6) return "retry";
  const normalized = transcript.trim().toLowerCase();
  if (YES_TOKENS.some(token => normalized.includes(token))) return "approved";
  if (NO_TOKENS.some(token => normalized.includes(token))) return "declined";
  return "retry";
}
```
- Realtime API から渡される `confidence`（音声認識信頼度）が 0.6 を下回る場合は再質問。
- `retry` の場合は PhaseManager が再度 `response.create` を発行（回数制限は別途設定）。
- トリガー語彙はログを見ながら随時拡張し、多言語や敬語に対応。

## 11. Realtime 呼び出し統合と再プロンプト設計
1. **呼び出しラッパーの用意**
   - `PhaseManager` から `RealtimeController.requestApproval(phaseCandidate, transitionId)` を呼ぶ構成にし、内部で `response.create` ペイロード（セクション9）を生成。
   - Realtime API とは既存の WebRTC セッションを共有し、DataChannel または REST Webhook で `conversation.item` を受け取る。
2. **応答待ちの状態管理**
   - `pendingTransition` として `transitionId`, `phaseCandidate`, `attempt`, `expiresAt` を保持。
   - Realtime 側から transcript を受け取ったらセクション10の `resolveApproval` を呼び出し、`approved/declined/retry` を判定。
3. **retry ハンドリング**
   - `retry` の場合は `attempt++` した上で `attempt <= MAX_ATTEMPTS` なら再度 `response.create` を送信。
   - `MAX_ATTEMPTS` は 2~3 回を目安に設定し、超過したら `declined` と同じ扱い、またはオペレーター通知。
4. **タイムアウト処理**
   - `expiresAt` を `now + 15s` などに設定し、定期的に監視。
   - タイムアウトしたら `retry` 扱いで再プロンプト、または `declined` としてユーザーに再度進行意欲を尋ねる。
   - タイムアウト時にフロントへステータス更新（例: "確認が取れませんでした" のテキスト提示）。
5. **結果通知とクリーンアップ**
   - `approved` の場合: `PhaseManager.confirmTransition(transitionId)` を実行しプロンプト切り替え。
   - `declined` の場合: `PhaseManager.cancelTransition(transitionId)` を実行し現フェーズを維持。
   - どちらの場合も `pendingTransition` をクリアし、UI へ最終結果を push。
6. **例外ハンドリング**
   - Realtime API からエラーが返った場合は即座に `declined` とし、UI へメッセージ提示。
   - 連続失敗時の fallback として、チャット UI に `はい/いいえ` ボタンを表示するオプションも検討。

### 疑似コード例
```typescript
async function requestApproval(phaseCandidate: Phase, transitionId: string) {
  const state = createPendingState(phaseCandidate, transitionId);
  sendResponseCreate(state);
  while (!state.isResolved()) {
    const event = await waitForConversationItem(state, TIMEOUT_MS);
    if (!event) {
      if (state.shouldRetry()) {
        state.incrementAttempt();
        sendResponseCreate(state);
        continue;
      }
      return handleDeclined(state, { reason: 'timeout' });
    }
    const result = resolveApproval(event.transcript, event.confidence);
    if (result === 'retry' && state.shouldRetry()) {
      state.incrementAttempt();
      sendResponseCreate(state);
      continue;
    }
    return result === 'approved'
      ? handleApproved(state)
      : handleDeclined(state, { reason: result });
  }
}
```

## 12. RealtimeController 実装方針
- **責務**: Realtime API セッションの初期化, 音声/テキストイベントの購読, `response.create` リクエスト送信, `conversation.item` 受信を統括。
- **構造案**:
  ```mermaid
  classDiagram
    class RealtimeController {
      +connect(sessionConfig)
      +requestApproval(phaseCandidate, transitionId)
      +onConversationItem(callback)
      +onSessionError(callback)
      +cleanup()
    }
  ```
  - `connect`: OpenAI Realtime API への接続を行い、WebRTC DataChannel (`realtime-events`) を開く。
  - `requestApproval`: セクション9のペイロードを送信。内部で `pendingTransition` を PhaseManager に通知。
  - `onConversationItem`: `conversation.item` 受信イベントを購読するリスナー登録 API。複数登録を許容し、PhaseManager から購読・解除。
  - `onSessionError`: ネットワーク障害や API エラーの通知用。
  - `cleanup`: セッション終了時に DataChannel/接続を解放。
- **DataChannel 利用**:
  - `realtime-events` チャンネルで JSON メッセージを受信。イベント形式は `{ type: 'conversation.item', data: {...} }` を想定。
  - 音声ストリームは既存の WebRTC MediaStream を継続利用。
- **イベント購読/解除**:
  - 内部で `Set` ベースのコールバック管理を行い、PhaseManager がフェーズ確認時のみ購読し、完了後に解除。
  - `conversation.item` の `metadata.request_id` が `pendingTransition.requestId` に一致するもののみ PhaseManager に渡す。
- **エラーハンドリング**:
  - DataChannel 切断時は `onSessionError` を発火し、PhaseManager から fallback UI を起動。
  - Realtime API からの `error` イベントを捕捉し、PhaseManager に `declined` 相当で通知。
- **再接続ポリシー**:
  - セッション再利用が難しい場合は `connect` を再実行し、新しいセッション ID を取得。遷移中であれば `declined` として扱う。
- **テレメトリ**:
  - 必要なら送信/受信イベントを一覧化し、タイムラグを計測するロギングを追加（省略可）。

## 13. RealtimeController モック実装計画
1. **モジュール骨格の作成**
   - `src/services/realtime/RealtimeController.ts` (または既存構成に合わせたディレクトリ) を新設。
   - クラス定義のみを置き、`connect`, `requestApproval`, `onConversationItem`, `onSessionError`, `cleanup` の署名と基本的な状態保持 (`session`, `listeners`) を実装。
2. **依存インターフェイスの定義**
   - Realtime API クライアント（既存ラッパがなければ `OpenAIRealtimeClient` のような薄い抽象）をモックできるよう、インターフェイスを別ファイルで定義。
   - PhaseManager 側から呼ばれる `RealtimeController` のインターフェイスを `src/services/realtime/types.ts` に切り出し、依存方向を明示。
3. **イベント購読のスタブ実装**
   - `onConversationItem` / `onSessionError` は `Set<Callback>` でリスナー登録・解除を実装。
   - `requestApproval` は現時点ではセクション9のペイロードをログ出力＋ダミーで `conversation.item` を即時呼び出すモック。
4. **PhaseManager 側の結線モック**
   - PhaseManager に `RealtimeController` を注入し、`requestApproval` → `resolveApproval` → `confirmTransition` のフローをテストコードでシミュレーション。
   - この段階では Realtime API への本接続は行わない。
5. **テスト戦略**
   - ユニット: リスナー登録・解除、`requestApproval` 内でのリスナー呼び出しなどを Jest で確認。
   - 統合（モック）: PhaseManager が `approved` / `declined` / `retry` を受け取るケースをテーブル駆動でテスト。
6. **後続ステップ**
   - 実際の Realtime API 呼び出しを行うアダプタを別クラス (`OpenAIRealtimeAdapter`) として実装し、`RealtimeController` に注入。
   - MediaStream 連携や DataChannel ハンドリングはアダプタ層で担当させ、モックとの差分を最小化する。
