import {
  RealtimeSession,
  RealtimeEvent,
  SessionUpdateEvent,
  ResponseCreateEvent,
  WebRTCManagerOptions
} from '../types/webrtc';
import { WebRTCManager } from './WebRTCManager';
import { AudioStreamProcessor } from './AudioStreamProcessor';
import { EphemeralTokenManager } from './EphemeralTokenManager';

/**
 * OpenAI Realtime APIとの統合クライアント
 * WebRTC、音声処理、APIイベント管理を統合
 */
export class RealtimeAPIClient {
  private webrtcManager: WebRTCManager;
  private audioProcessor: AudioStreamProcessor | null = null;
  private tokenManager: EphemeralTokenManager;
  private autoMutedByAssistant: boolean = false;
  private autoMuteTimeoutId: number | null = null;

  private currentSession: RealtimeSession | null = null;
  private consultantId: string | null = null;
  private sessionState: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

  // 会話の状態管理
  private conversationPhase: 'questions' | 'hot-reading' | 'cold-reading' | 'subsidies' | 'summary' | 'recommendations' = 'questions';
  private messageHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];

  // 音声転写管理
  private lastUserTranscript: string = '';
  private lastAssistantTranscript: string = '';

  // イベントハンドラー
  private eventHandlers: Map<string, Set<Function>> = new Map();

  constructor(options: Partial<WebRTCManagerOptions> = {}) {
    // WebRTCManagerを初期化
    this.webrtcManager = new WebRTCManager(options);
    this.tokenManager = new EphemeralTokenManager(options.tokenServiceUrl || '/api/session');

    // WebRTCイベントをリレー
    this.setupWebRTCEventRelay();
  }

  /**
   * WebRTCイベントのリレー設定
   */
  private setupWebRTCEventRelay(): void {
    // 接続状態の変化
    this.webrtcManager.on('connected', () => {
      this.sessionState = 'connected';
      this.emit('connected', { sessionState: this.sessionState });
    });

    this.webrtcManager.on('connectionfailed', () => {
      this.sessionState = 'error';
      this.emit('connectionfailed', { sessionState: this.sessionState });
    });

    // Realtimeイベントの処理
    this.webrtcManager.on('realtimeevent', (event: RealtimeEvent) => {
      this.handleRealtimeEvent(event);
    });

    // 音声関連イベント
    this.webrtcManager.on('audioresponse', (event: RealtimeEvent) => {
      this.emit('audioresponse', event);
    });

    this.webrtcManager.on('textresponse', (event: RealtimeEvent) => {
      this.emit('textresponse', event);
    });

    // 入力音声可視化/ミュート状態のリレー
    this.webrtcManager.on('audiolevel', (data: any) => {
      this.emit('audiolevel', data);
    });

    this.webrtcManager.on('mutedstatechanged', (data: any) => {
      this.emit('mutedstatechanged', data);
    });

    // リモート側（必要に応じてUIへ）
    this.webrtcManager.on('remoteaudiomutedchanged', (data: any) => {
      this.emit('remoteaudiomutedchanged', data);
    });
    this.webrtcManager.on('remoteaudiovolumechanged', (data: any) => {
      this.emit('remoteaudiovolumechanged', data);
    });

    // エラーイベント
    this.webrtcManager.on('error', (error: { type: string; message: string; [key: string]: any }) => {
      this.emit('error', error);
    });
  }

  /**
   * セッションの初期化と接続確立
   */
  async initializeSession(consultantId: string): Promise<RealtimeSession> {
    console.log('=== Initialize Session Called ===');
    console.log('Consultant ID:', consultantId);

    try {
      this.sessionState = 'connecting';
      this.consultantId = consultantId;

      console.log('Emitting session initializing event...');
      this.emit('sessioninitializing', { consultantId });

      // WebRTC接続を確立
      console.log('Connecting WebRTC...');
      await this.webrtcManager.connect();
      console.log('WebRTC connected');

      // 念のためマイクを有効化（前回の自動ミュートが残っていた場合の復旧）
      try {
        this.webrtcManager.setMuted(false);
      } catch (_) {
        // no-op
      }

      // 音声処理を開始
      console.log('Setting up audio processing...');
      await this.setupAudioProcessing();
      console.log('Audio processing setup completed');

      // セッション設定を送信
      console.log('Configuring session...');
      await this.configureSession(consultantId);
      console.log('Session configuration completed');

      this.sessionState = 'connected';
      this.emit('sessioninitialized', {
        session: this.currentSession,
        consultantId
      });

      return this.currentSession!;

    } catch (error) {
      this.sessionState = 'error';
      this.emit('error', {
        type: 'session_initialization_error',
        message: error instanceof Error ? error.message : 'Failed to initialize session'
      });
      throw error;
    }
  }

  /**
   * 音声処理のセットアップ
   */
  private async setupAudioProcessing(): Promise<void> {
    try {
      this.audioProcessor = new AudioStreamProcessor({
        sampleRate: 24000,
        channelCount: 1,
        bufferSize: 2048,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      });

      await this.audioProcessor.initialize();

      // 音声レベル監視を開始
      this.webrtcManager.startAudioLevelMonitoring();

      // VADイベントの処理
      this.audioProcessor.on('vadstatechange', (vad: { isActive: boolean; rmsLevel?: number; confidence?: number }) => {
        this.emit('voiceactivitychange', vad);
        // サーバーVADを使用するため、手動のVADイベント送信は行わない（誤バージイン防止）
      });

    } catch (error) {
      throw new Error(`Audio processing setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * セッション設定の送信
   */
  private async configureSession(consultantId: string): Promise<void> {
    console.log('=== Configure Session Started ===');
    console.log('Consultant ID:', consultantId);

    console.log('Building session configuration...');
    const sessionConfig: SessionUpdateEvent = {
      type: 'session.update',
      event_id: this.generateEventId(),
      session: {
        modalities: ['text', 'audio'],
        instructions: await this.buildConsultantInstructions(consultantId),
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1000
        },
        tools: [],
        tool_choice: 'none',
        temperature: 0.7,
        max_response_output_tokens: 4096
      }
    };

    console.log('Sending session configuration...');
    this.sendRealtimeEvent(sessionConfig);

    // 初期化完了まで待機
    console.log('Waiting for session creation...');
    await this.waitForSessionCreated();
    console.log('Session creation completed');

    // 既存接続の場合でも必ずプロンプト更新を実行
    console.log('=== Force updating consultant instructions ===');
    if (this.webrtcManager.isConnected()) {
      console.log('Existing connection detected - forcing prompt update');
      await this.updateSessionInstructions();
    } else {
      console.log('New connection - updating instructions');
      await this.updateSessionInstructions();
    }
    console.log('=== Consultant instructions initialized ===');
    console.log('=== Configure Session Completed ===');
  }

  /**
   * コンサルタント固有の指示文を構築
   */
  private async buildConsultantInstructions(consultantId: string): Promise<string> {
    const consultant = await this.getConsultantData(consultantId);

    if (!consultant) {
      throw new Error(`Consultant with ID ${consultantId} not found`);
    }

    // 生成関数呼び出しはコメントアウト（現行の長文テンプレートを使用）
    // const phaseInstructions = this.getPhaseSpecificInstructions();
    // const personalityTraits = this.generatePersonalityTraits(consultant);
    // const expertiseDetails = this.generateExpertiseDetails(consultant);
    // const networkInformation = this.generateNetworkInformation(consultant);

    const instruction = `
あなたは「${consultant.name}」として振る舞います。

「#基本方針」と「#コンサル手順」に従って、コンサルタントをすること。

#基本方針
- 返信は日本語で100字以内・完結文。
- 「手順」は止まることなく続行してください。1つの手順は1回の発言で必ず終了して次の手順に移行してください。
- 信頼の二軸を同時に獲得：「人として信頼」＋「プロとして信頼」
- 専門語には必ず平易補足を添える、売り込み禁止
- 短く・具体・やさしく。相手の時間を節約する表現を最優先。押し売りしない。
- 相手が「相談は終わり」「相談は終了」などと言ったら、それまでの情報を元に最適な人材を紹介する ##手順7 を実行してください

#コンサル手順
##手順1: 業界、事業規模、従業員数を聞く
##手順2: 既存の取引先さんはどんなところかを聞く
##手順3: 目的確認と許可取りをとって次のフェーズへ進む。「今日は御社の課題整理をさせていただき、最適案の合意まで進めても良いですか？」
##手順4: 課題の確認。「現状で課題だと考えているのはどこですか？」
##手順5: すでにやったアクションを確認。「その課題に対して、これまでにどのようなアクションを取ってきましたか？」
##手順6: 相手の考えを聞く「何か解決すれば、その課題が解決すると思いますか？」
##手順7: これまでの話をまとめて #紹介可能人脈 からマッチングする候補の概要を紹介
##手順8: どんな人が良いかをヒアリング。専門領域や性格（キッチリ進める人がいい、スピードが速い人がいい、素直、勉強熱心、価格が安い、など）

#出力フォーマット（厳守）
- 紹介を行うときは、必ず「2つの出力アイテム」を連続して生成する。
  1) 会話本文（自然な話し言葉）。これは audio を伴う。タグ語（RECO/タグ/JSON/角括弧 等）を本文に一切含めない。
  2) テキストのみのメタ情報メッセージ。内容は厳密に1行のみ、余計な文字なしで <RECO>{"ids":[...]}</RECO> とする（audio は生成しない）。JSON は最小表記（スペース無し）。
- 例:
  - 本文: 「最適な候補を2社ご紹介します。まずは株式会社Wiz、次にアイ・クリエイティブです。」
  - テキストのみ: <RECO>{"ids":["株式会社Wiz","アイ・クリエイティブ"]}</RECO>
- ids には #紹介可能人脈 に記載の会社名（および必要なら別表記）を、本文と同一表記で配列として含めること。
- 「RECO」という語やタグに関する説明は本文で絶対に発話しない（読み上げ禁止）。

#紹介可能人脈
##コスト削減

### 法人携帯
	•	企業名: 株式会社Wiz
	•	代表: 山崎 俊 / 担当者: 佐賀 準平
	•	URL: 公式ページ
	•	紹介文: 企業の成長を支援するDXツール導入サービス。売上向上やコスト削減、業務効率化を実現する最適なソリューションを提案。

### 電気代削減
	•	企業名: 株式会社アライズ
	•	代表/担当者: 中田 治
	•	URL: Facebookメッセージ
	•	紹介文: 全国トップレベルのお得な電気代を提供。供給品質は維持しつつ、利用状況に応じた最適料金プランを提案。

### 社会保険料削減（はぐくみ企業年金）
	•	企業名: 株式会社ベター・プレイス
	•	代表/担当者: 森本 新兒
	•	LP: 詳細ページ
	•	紹介文: 中小企業中心に導入3000社以上。経営者も加入可能な「お金の福利厚生」。社会保険料削減と福利厚生強化を同時に実現。

## その他削減コンテンツ
### 総合FP資産形成・コンサルティング株式会社
	•	代表: 上實 貴一 / 担当: 神田 新
	•	紹介資料
	•	元国税調査官推奨の節税繰延スキーム。タイミング調整可能でキャッシュフロー改善。

### 株式会社日本企業型確定拠出年金センター
	•	代表/担当: 久野 勝也
	•	紹介資料
	•	役員退職金準備・社会保険削減・従業員満足向上を実現する制度。

### ノービス・コンサルタンツ・インターナショナル株式会社
	•	代表/担当: 櫻井 博
	•	紹介資料
	•	導入資金を償却に充てられるスキーム設計が得意。

## その他カテゴリ

### 集客マーケティング
•	SANGO株式会社: 営業代行国内No.1実績。代理店・FC開拓プラットフォーム「カケハシ」運営。
•	Acroforce株式会社: 経営者特化型X運用「プロネス」。上場〜スタートアップまで支援実績多数。
•	BOTANICO: Webマーケ×制作。定額でマーケ施策依頼し放題の「ASHINAMI」。

### 健康経営サポート
	•	株式会社MYPLATE: 健康経営優良法人認定取得支援＋健康食提供。
	•	株式会社国産の生活: 農家直送国産健康弁当（初期費用・月額無料）。

### 研修
	•	アイ・クリエイティブ: 講師400名・助成金活用可。
	•	眼から鱗合同会社: 幹部研修＋メンタリング、AI時代対応型リーダー育成。

### 人材・HR
	•	株式会社ユワナビ: 採用代行＋人材紹介「らくらくらく採用」。
	•	株式会社エーライド: エリア・業界問わず採用伴走支援。

### システム開発 / DX
	•	株式会社Oneplat①: コンサル付き受託開発。基幹システム〜高難易度案件対応。
	•	株式会社Oneplat②: 請求書・納品書データ100%精度取得＋自動仕訳。経理工数大幅削減。



    `


    // ####手順9:
    // ####手順10:


    // ## フェーズ2「ホットリーディング」
    // ###進行1 ここではヒアリング内容をもとに2ターン会話します。この段階ではまだ具体的な紹介はしないでください。
    // ####手順1: 課題の確認。「現状で課題だと考えているのはどこですか？」
    // ####手順2: 具体的な解決方法については深掘りしない。状況のヒアリングのみ。
    // ####手順3: 課題を明確化して次のフェーズへ進む

    // ## フェーズ3「コールドリーディング」
    // ###進行1 これまでの情報から、2ターン会話します。この段階ではまだ具体的な紹介はしないでください。
    // ####手順1: コールドリーディングの手法で課題から類推して誰にでも当てはまることを最もらしく発言
    // ####手順2: 具体的な解決方法については深掘りしない。状況のヒアリングのみ。
    // ####手順3: 再び課題を明確化して、次のフェーズへ進む

    // ## フェーズ4「紹介」
    // ###進行1 これまでの情報を総合して、紹介可能人脈からマッチングする候補の概要を紹介します。
    // ####手順1: これまでの話をまとめて #紹介可能人脈 からマッチングする候補の概要を紹介
    // ####手順2: どんな人が良いかをヒアリング。専門領域や性格（キッチリ進める人がいい、スピードが速い人がいい、素直、勉強熱心、価格が安い、など）
    // ####手順3: ヒアリング内容を総合して #紹介可能人脈 からマッチング候補を紹介



//     const instruction = `
// # あなたのアイデンティティ
// あなたは「${consultant.name}」として振る舞います。${consultant.experience}

// ## パーソナリティ
// ${personalityTraits}

// ## 専門性と経験
// ${expertiseDetails}

// ## ネットワークと人脈
// ${networkInformation}

// ## 現在の会話フェーズ: ${this.conversationPhase}
// ${phaseInstructions}

// ## 音声会話での振る舞い
// - 自然で親しみやすい口調で話す
// - 適度な間を取り、相手の発言を最後まで聞く
// - 専門用語を使う際は、分かりやすい説明を加える
// - 具体例や事例を交えて説明する
// - クライアントの状況に応じて柔軟にアドバイスを調整する

// ## 重要な注意点
// - 常に実用的で行動につながるアドバイスを心がける
// - 自分の専門外の分野については素直に認める
// - クライアントの業界や状況を深く理解しようとする姿勢を示す
// - 必要に応じて、適切な専門家や人脈を紹介する提案をする

// あなたの豊富な経験と人脈を活かして、クライアントの課題解決に貢献してください。
// `;

    console.log('=== Built Consultant Instructions ===');
    console.log('Instructions length:', instruction.length);
    console.log('Instructions preview:', instruction.substring(0, 200) + '...');
    console.log('=====================================');

    return instruction;
  }

  /**
   * 既存のコンサルタントデータを取得
   */
  private async getConsultantData(consultantId: string): Promise<any> {
    // 動的インポートでコンサルタントデータを取得
    try {
      const { consultants } = await import('../data/consultants');
      return consultants.find((c: any) => c.id === consultantId);
    } catch (error) {
      console.error('Failed to load consultant data:', error);
      return null;
    }
  }

  /**
   * フェーズ固有の指示文を生成
   */
  private getPhaseSpecificInstructions(): string {
    switch (this.conversationPhase) {
      case 'questions':
        return `
### 質問フェーズの進め方
- クライアントの業界、事業規模、現在の課題を順番に聞き取る
- 「どのような業界でご活動されていますか？」「現在、どのような課題をお持ちですか？」など、オープンクエスチョンを活用
- クライアントの回答に基づいて、さらに深掘りする質問を投げかける
- このフェーズでは、情報収集に集中し、早急な解決策提示は控える`;

      case 'hot-reading':
        return `
### ホットリーディングフェーズの進め方
- 聞き取った情報から、即座に分析できるポイントを指摘
- 「お聞きした内容から、○○という課題が見えてきますね」のように、洞察を共有
- 一般的な業界動向や類似事例があれば簡潔に紹介
- クライアントの状況の整理と、問題の本質を明確化する`;

      case 'cold-reading':
        return `
### コールドリーディングフェーズの進め方
- より深い業界知識と専門性を発揮する段階
- 過去の経験から得られた深い洞察や、業界の将来展望を共有
- 「私の経験では...」「この業界でよく見られるパターンとして...」など、具体的な経験を交える
- 潜在的なリスクや機会についても言及する`;

      case 'subsidies':
        return `
### 補助金・支援制度フェーズの進め方
- クライアントの業界や規模に適用できる補助金や支援制度を紹介
- IT導入補助金、事業再構築補助金、小規模事業者持続化補助金など、具体的な制度名を挙げる
- 申請時期、条件、必要書類などの実務的な情報も提供
- 「このような制度がご活用いただけそうです」と具体的に提案する`;

      case 'summary':
        return `
### まとめフェーズの進め方
- これまでの会話で明らかになった課題と解決の方向性を整理
- 「本日お聞きした内容をまとめますと...」として、要点を3-5つに絞って説明
- クライアントの状況と提案した解決策の整合性を確認
- 次のステップに向けた準備として情報を整理する`;

      case 'recommendations':
        return `
### 推奨事項フェーズの進め方
- 具体的で実行可能な次のステップを提案
- 短期（1-3ヶ月）、中期（3-6ヶ月）、長期（6ヶ月以上）の時間軸で整理
- 人脈紹介が可能な場合は具体的に提案「○○業界の△△様をご紹介できます」
- 実行に向けた具体的なアクションプランを提示する`;

      default:
        return '現在のフェーズに応じた適切なアドバイスを提供してください。';
    }
  }

  /**
   * パーソナリティ特性を生成
   */
  private generatePersonalityTraits(consultant: any): string {
    let traits = [];

    // 経験年数から推測される特性
    if (consultant.experience.includes('20年') || consultant.experience.includes('15年')) {
      traits.push('豊富な経験に基づく落ち着いた判断力');
      traits.push('業界の変遷を知る歴史的視点');
    } else if (consultant.experience.includes('10年')) {
      traits.push('実務経験と新しい知識のバランスが取れた視点');
    } else {
      traits.push('最新の業界動向に敏感');
      traits.push('フレッシュな視点と積極性');
    }

    // 役職から推測される特性
    if (consultant.experience.includes('社長') || consultant.experience.includes('経営')) {
      traits.push('経営者目線での戦略的思考');
      traits.push('リーダーシップと決断力');
    } else if (consultant.experience.includes('マネージャー') || consultant.experience.includes('部長')) {
      traits.push('マネジメント経験による組織運営の知見');
    }

    // 業界特性
    if (consultant.specialties.includes('IT・テクノロジー')) {
      traits.push('デジタル変革への深い理解');
      traits.push('テクノロジートレンドへの感度');
    } else if (consultant.specialties.includes('金融・保険')) {
      traits.push('リスク管理への慎重な姿勢');
      traits.push('数字に基づく論理的分析');
    }

    return traits.map(trait => `- ${trait}`).join('\n');
  }

  /**
   * 専門性の詳細を生成
   */
  private generateExpertiseDetails(consultant: any): string {
    const details = [];

    details.push(`**主要専門分野**: ${consultant.specialties.join('、')}`);
    details.push(`**核心的な専門知識**: ${consultant.expertise}`);

    // 業界別の詳細知識
    consultant.specialties.forEach((specialty: string) => {
      switch (specialty) {
        case 'IT・テクノロジー':
          details.push('- DX推進、システム導入、IT投資対効果分析');
          details.push('- SaaS活用、クラウド移行、データ活用戦略');
          break;
        case '製造業':
          details.push('- 製造プロセス改善、品質管理、サプライチェーン最適化');
          details.push('- 工場自動化、IoT導入、スマートファクトリー化');
          break;
        case '金融・保険':
          details.push('- 金融商品設計、リスク評価、コンプライアンス対応');
          details.push('- フィンテック活用、デジタルバンキング、保険商品革新');
          break;
        case 'ヘルスケア':
          details.push('- 医療機器導入、薬事法対応、医療IT活用');
          details.push('- 病院経営改善、医療DX推進、患者体験向上');
          break;
        case '人材・HR':
          details.push('- 採用戦略立案、人事制度設計、タレントマネジメント');
          details.push('- HRテック活用、働き方改革、従業員エンゲージメント向上');
          break;
      }
    });

    return details.join('\n');
  }

  /**
   * ネットワーク情報を生成
   */
  private generateNetworkInformation(consultant: any): string {
    const details = [];

    details.push(`**保有人脈**: ${consultant.connections}`);
    details.push('');
    details.push('**紹介可能な専門家・パートナー**:');

    // 専門分野に応じた人脈の詳細
    consultant.specialties.forEach((specialty: string) => {
      switch (specialty) {
        case 'IT・テクノロジー':
          details.push('- IT企業の技術責任者、CTOクラス');
          details.push('- システム開発会社の営業責任者');
          details.push('- デジタルマーケティング専門家');
          break;
        case '製造業':
          details.push('- 製造業の経営陣、工場長クラス');
          details.push('- 設備メーカーの技術営業');
          details.push('- 品質管理コンサルタント');
          break;
        case '金融・保険':
          details.push('- 金融機関の部門責任者');
          details.push('- 保険会社の商品企画担当');
          details.push('- フィンテック企業の事業開発責任者');
          break;
        case 'ヘルスケア':
          details.push('- 病院・クリニックの経営陣');
          details.push('- 医療機器メーカーの営業責任者');
          details.push('- 医療ITベンダーの開発責任者');
          break;
        case '人材・HR':
          details.push('- 企業の人事部長、採用責任者');
          details.push('- 人材紹介会社のコンサルタント');
          details.push('- HRテック企業の営業責任者');
          break;
      }
    });

    return details.join('\n');
  }

  /**
   * セッション作成完了まで待機
   */
  private async waitForSessionCreated(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      // WebRTC接続が既に確立されている場合は即座にresolve
      if (this.webrtcManager.isConnected()) {
        console.log('✅ WebRTC already connected, skipping session.created wait');
        resolve();
        return;
      }

      console.log(`⏳ Waiting for session.created event (timeout: ${timeoutMs}ms)`);

      const timeout = setTimeout(() => {
        console.warn('⚠️ Session creation timeout - but WebRTC might still be working');
        // WebRTC接続が実際に動作している場合はエラーにしない
        if (this.webrtcManager.isConnected()) {
          console.log('✅ WebRTC connection detected despite timeout, proceeding...');
          resolve();
        } else {
          reject(new Error('Session creation timeout'));
        }
      }, timeoutMs);

      const handleSessionCreated = (event: RealtimeEvent) => {
        if (event.type === 'session.created') {
          console.log('✅ session.created event received');
          clearTimeout(timeout);
          this.off('realtimeevent', handleSessionCreated);
          this.currentSession = (event as any).session;
          resolve();
        }
      };

      // WebRTC接続状態の監視
      const handleWebRTCConnection = () => {
        if (this.webrtcManager.isConnected()) {
          console.log('✅ WebRTC connection established, proceeding without session.created');
          clearTimeout(timeout);
          this.off('realtimeevent', handleSessionCreated);
          resolve();
        }
      };

      this.on('realtimeevent', handleSessionCreated);

      // WebRTC接続状態を定期的にチェック
    const connectionCheck = setInterval(() => {
        if (this.webrtcManager.isConnected()) {
          clearInterval(connectionCheck);
          handleWebRTCConnection();
        }
      }, 1000);

      // タイムアウト時にintervalもクリア
      setTimeout(() => {
        clearInterval(connectionCheck);
      }, timeoutMs);
    });
  }

  /**
   * Realtimeイベントの送信
   */
  sendRealtimeEvent(event: RealtimeEvent): void {
    if (event.type === 'session.update' && 'session' in event && event.session?.instructions) {
      console.log('=== Sending Session Update with Instructions ===');
      console.log('Event type:', event.type);
      console.log('Instructions preview:', event.session.instructions.substring(0, 300) + '...');
      console.log('===============================================');
    }

    this.webrtcManager.sendRealtimeEvent(event);
    this.emit('eventsent', event);
  }

  /**
   * Realtimeイベントの詳細処理
   */
  private handleRealtimeEvent(event: RealtimeEvent): void {
    // イベントログ
    this.logRealtimeEvent(event);

    switch (event.type) {
      case 'session.created':
        this.handleSessionCreated(event as any);
        break;

      case 'session.updated':
        this.handleSessionUpdated(event as any);
        break;

      case 'input_audio_buffer.committed':
        this.handleAudioBufferCommitted(event as any);
        break;

      case 'input_audio_buffer.cleared':
        this.handleAudioBufferCleared(event as any);
        break;

      case 'input_audio_buffer.speech_started':
        this.handleSpeechStarted(event as any);
        break;

      case 'input_audio_buffer.speech_stopped':
        this.handleSpeechStopped(event as any);
        break;

      case 'conversation.item.created':
        this.handleConversationItemCreated(event as any);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.handleInputAudioTranscriptionCompleted(event as any);
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this.handleInputAudioTranscriptionFailed(event as any);
        break;

      case 'response.created':
        this.handleResponseCreated(event as any);
        break;

      case 'response.output_item.added':
        this.handleResponseOutputItemAdded(event as any);
        break;

      case 'response.content_part.added':
        this.handleResponseContentPartAdded(event as any);
        break;

      case 'response.text.delta':
        this.handleTextDelta(event as any);
        break;

      case 'response.text.done':
        this.handleTextDone(event as any);
        break;

      case 'response.audio.delta':
        this.handleAudioDelta(event as any);
        break;

      case 'response.audio.done':
        this.handleAudioDone(event as any);
        break;

      case 'response.output_item.done':
        this.handleResponseOutputItemDone(event as any);
        break;

      case 'response.audio_transcript.done':
        this.handleResponseAudioTranscriptDone(event as any);
        break;

      case 'response.done':
        this.handleResponseDone(event as any);
        break;

      case 'rate_limits.updated':
        this.handleRateLimitsUpdated(event as any);
        break;

      case 'error':
        this.handleRealtimeError(event as any);
        break;

      default:
        this.emit('unknownrealtimeevent', event);
        break;
    }
  }

  /**
   * イベントログの記録
   */
  private logRealtimeEvent(event: RealtimeEvent): void {
    this.emit('eventlog', {
      timestamp: Date.now(),
      type: event.type,
      event_id: event.event_id,
      event
    });
  }

  /**
   * セッション作成イベントの処理
   */
  private handleSessionCreated(event: any): void {
    this.currentSession = event.session;
    this.emit('sessioncreated', {
      session: event.session,
      event_id: event.event_id
    });
  }

  /**
   * セッション更新イベントの処理
   */
  private handleSessionUpdated(event: any): void {
    if (this.currentSession) {
      this.currentSession = { ...this.currentSession, ...event.session };
    }
    this.emit('sessionupdated', {
      session: this.currentSession,
      event_id: event.event_id
    });
  }

  /**
   * 音声バッファコミットの処理
   */
  private handleAudioBufferCommitted(event: any): void {
    this.emit('audiobuffercommitted', {
      previous_item_id: event.previous_item_id,
      item_id: event.item_id
    });
  }

  /**
   * 音声バッファクリアの処理
   */
  private handleAudioBufferCleared(event: any): void {
    this.emit('audiobuffercleared', {
      event_id: event.event_id
    });
  }

  /**
   * 音声転写完了処理
   */
  private handleInputAudioTranscriptionCompleted(event: any): void {
    const transcript = event.transcript || '';
    this.lastUserTranscript = transcript;

    console.log('🎤 User transcript:', transcript);

    // メッセージ履歴を更新
    this.messageHistory.push({
      role: 'user',
      content: transcript,
      timestamp: Date.now()
    });

    this.emit('usertranscript', {
      transcript,
      timestamp: Date.now()
    });
  }

  /**
   * 音声転写失敗処理
   */
  private handleInputAudioTranscriptionFailed(event: any): void {
    console.warn('❌ User transcription failed:', event);
    this.emit('usertranscriptfailed', event);
  }

  /**
   * AI応答の音声転写完了処理
   */
  private handleResponseAudioTranscriptDone(event: any): void {
    let transcript = event.transcript || '';
    // ここでも <RECO>…</RECO> を抽出してイベント化・表示用からは除去
    const match = transcript.match(/<RECO>(.*?)<\/RECO>/);
    if (match) {
      try {
        const payload = JSON.parse(match[1]);
        if (payload && Array.isArray(payload.ids)) {
          this.emit('recommendationssuggested', { ids: payload.ids });
        }
      } catch {}
      transcript = transcript.replace(match[0], '').trim();
    }
    this.lastAssistantTranscript = transcript;

    console.log('🤖 Assistant transcript:', transcript);

    // メッセージ履歴を更新
    this.messageHistory.push({
      role: 'assistant',
      content: transcript,
      timestamp: Date.now()
    });

    this.emit('assistanttranscript', {
      transcript,
      timestamp: Date.now()
    });
  }

  /**
   * 発話開始の処理
   */
  private handleSpeechStarted(event: any): void {
    this.emit('speechstarted', {
      audio_start_ms: event.audio_start_ms,
      item_id: event.item_id
    });
  }

  /**
   * 発話停止の処理
   */
  private handleSpeechStopped(event: any): void {
    this.emit('speechstopped', {
      audio_end_ms: event.audio_end_ms,
      item_id: event.item_id
    });
  }

  /**
   * 会話アイテム作成の処理
   */
  private handleConversationItemCreated(event: any): void {
    const item = event.item;

    // メッセージ履歴に追加
    this.addToMessageHistory(item);

    this.emit('conversationitemcreated', {
      previous_item_id: event.previous_item_id,
      item: item
    });
  }

  /**
   * レスポンス作成の処理
   */
  private handleResponseCreated(event: any): void {
    this.emit('responsecreated', {
      response: event.response
    });
  }

  /**
   * レスポンス出力アイテム追加の処理
   */
  private handleResponseOutputItemAdded(event: any): void {
    this.emit('responseoutputitemadded', {
      response_id: event.response_id,
      output_index: event.output_index,
      item: event.item
    });
  }

  /**
   * レスポンスコンテンツパート追加の処理
   */
  private handleResponseContentPartAdded(event: any): void {
    this.emit('responsecontentpartadded', {
      response_id: event.response_id,
      item_id: event.item_id,
      output_index: event.output_index,
      content_index: event.content_index,
      part: event.part
    });
  }

  /**
   * テキストデルタの処理
   */
  private handleTextDelta(event: any): void {
    this.emit('textdelta', {
      response_id: event.response_id,
      item_id: event.item_id,
      output_index: event.output_index,
      content_index: event.content_index,
      delta: event.delta
    });
  }

  /**
   * テキスト完了の処理
   */
  private handleTextDone(event: any): void {
    let text = event.text || '';
    const match = text.match(/<RECO>(.*?)<\/RECO>/);
    if (match) {
      try {
        const payload = JSON.parse(match[1]);
        if (payload && Array.isArray(payload.ids)) {
          this.emit('recommendationssuggested', { ids: payload.ids });
        }
      } catch {}
      text = text.replace(match[0], '').trim();
    }
    this.emit('textdone', {
      response_id: event.response_id,
      item_id: event.item_id,
      output_index: event.output_index,
      content_index: event.content_index,
      text
    });
  }

  /**
   * 音声デルタの処理
   */
  private handleAudioDelta(event: any): void {
    // アシスタントの音声出力が始まったタイミングで自動ミュート
    if (!this.autoMutedByAssistant) {
      const alreadyMuted = this.webrtcManager.isMuted();
      if (!alreadyMuted) {
        this.webrtcManager.setMuted(true);
        this.autoMutedByAssistant = true;
      }
    }
    // ウォッチドッグ: デルタが一定時間来なければ自動解除（ハング防止）
    this.scheduleAutoUnmute(8000);
    this.emit('audiodelta', {
      response_id: event.response_id,
      item_id: event.item_id,
      output_index: event.output_index,
      content_index: event.content_index,
      delta: event.delta
    });
  }

  /**
   * 音声完了の処理
   */
  private handleAudioDone(event: any): void {
    // 音声出力が完了したら自動ミュートのみ解除
    this.clearAutoUnmuteTimer();
    if (this.autoMutedByAssistant) {
      this.webrtcManager.setMuted(false);
      this.autoMutedByAssistant = false;
    }
    this.emit('audiodone', {
      response_id: event.response_id,
      item_id: event.item_id,
      output_index: event.output_index,
      content_index: event.content_index
    });
  }

  /**
   * レスポンス出力アイテム完了の処理
   */
  private handleResponseOutputItemDone(event: any): void {
    this.emit('responseoutputitemdone', {
      response_id: event.response_id,
      output_index: event.output_index,
      item: event.item
    });
  }

  /**
   * レスポンス完了の処理
   */
  private handleResponseDone(event: any): void {
    this.emit('responsecomplete', {
      response: event.response,
      status: event.response.status,
      status_details: event.response.status_details
    });

    // 会話フェーズの自動進行を検討
    this.considerPhaseProgression(event.response);

    // 念のため、レスポンス完了時にも自動ミュート解除（安全弁）
    this.clearAutoUnmuteTimer();
    if (this.autoMutedByAssistant) {
      this.webrtcManager.setMuted(false);
      this.autoMutedByAssistant = false;
    }
  }

  private scheduleAutoUnmute(timeoutMs: number): void {
    this.clearAutoUnmuteTimer();
    this.autoMuteTimeoutId = window.setTimeout(() => {
      if (this.autoMutedByAssistant) {
        this.webrtcManager.setMuted(false);
        this.autoMutedByAssistant = false;
      }
      this.autoMuteTimeoutId = null;
    }, timeoutMs);
  }

  private clearAutoUnmuteTimer(): void {
    if (this.autoMuteTimeoutId !== null) {
      clearTimeout(this.autoMuteTimeoutId);
      this.autoMuteTimeoutId = null;
    }
  }

  /**
   * レート制限更新の処理
   */
  private handleRateLimitsUpdated(event: any): void {
    this.emit('ratelimitsupdated', {
      rate_limits: event.rate_limits
    });
  }

  /**
   * Realtime APIエラーの処理
   */
  private handleRealtimeError(event: any): void {
    const error = event.error;

    this.emit('realtimeapierror', {
      type: error.type,
      code: error.code,
      message: error.message,
      param: error.param,
      event_id: error.event_id || event.event_id
    });

    // 重要なエラーの場合は接続状態を更新
    if (error.type === 'session_expired' || error.type === 'connection_error') {
      this.sessionState = 'error';
    }
  }

  /**
   * メッセージ履歴への追加
   */
  private addToMessageHistory(item: any): void {
    if (item.type === 'message') {
      let content = '';

      // コンテンツの抽出
      if (item.content) {
        item.content.forEach((contentPart: any) => {
          if (contentPart.type === 'text') {
            // 表示用テキストからは <RECO>…</RECO> を除去
            const cleaned = String(contentPart.text).replace(/<RECO>[\s\S]*?<\/RECO>/g, '').trim();
            content += cleaned;
          } else if (contentPart.type === 'audio') {
            content += '[音声コンテンツ]';
          }
        });
      }

      this.messageHistory.push({
        role: item.role,
        content,
        timestamp: Date.now()
      });

      // 履歴サイズの制限（最新100メッセージまで）
      if (this.messageHistory.length > 100) {
        this.messageHistory = this.messageHistory.slice(-100);
      }

      this.emit('messagehistoryupdated', {
        messageCount: this.messageHistory.length,
        latestMessage: this.messageHistory[this.messageHistory.length - 1]
      });
    }
  }

  /**
   * 会話フェーズの自動進行を検討
   */
  private considerPhaseProgression(response: any): void {
    const messageCount = this.messageHistory.length;

    // 簡単なフェーズ進行ロジック
    switch (this.conversationPhase) {
      case 'questions':
        if (messageCount >= 4) { // 2往復程度でホットリーディングに移行
          this.setConversationPhase('hot-reading');
        }
        break;

      case 'hot-reading':
        if (messageCount >= 8) { // さらに2往復でコールドリーディングに
          this.setConversationPhase('cold-reading');
        }
        break;

      case 'cold-reading':
        if (messageCount >= 12) { // 補助金情報へ
          this.setConversationPhase('subsidies');
        }
        break;

      case 'subsidies':
        if (messageCount >= 16) { // まとめへ
          this.setConversationPhase('summary');
        }
        break;

      case 'summary':
        if (messageCount >= 18) { // 推奨事項へ
          this.setConversationPhase('recommendations');
        }
        break;
    }
  }

  /**
   * 手動での音声入力バッファ操作
   */
  commitAudioBuffer(): void {
    this.sendRealtimeEvent({
      type: 'input_audio_buffer.commit',
      event_id: this.generateEventId()
    });
  }

  clearAudioBuffer(): void {
    this.sendRealtimeEvent({
      type: 'input_audio_buffer.clear',
      event_id: this.generateEventId()
    });
  }

  /**
   * 会話履歴の取得
   */
  getMessageHistory(): Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> {
    return [...this.messageHistory];
  }

  /**
   * 特定フェーズへの強制移行
   */
  forcePhaseTransition(phase: typeof this.conversationPhase): void {
    this.setConversationPhase(phase);
  }

  /**
   * 会話フェーズの変更
   */
  setConversationPhase(phase: typeof this.conversationPhase): void {
    this.conversationPhase = phase;

    // フェーズに応じた指示文の更新
    this.updateSessionInstructions();

    this.emit('phasechanged', { phase });
  }

  /**
   * セッション指示文の更新
   */
  private async updateSessionInstructions(): Promise<void> {
    if (!this.consultantId || !this.currentSession) return;

    const updatedInstructions = await this.buildConsultantInstructions(this.consultantId);

    console.log('=== Updating Session Instructions ===');
    console.log('Consultant ID:', this.consultantId);
    console.log('Instructions preview:', updatedInstructions.substring(0, 200) + '...');
    console.log('=====================================');

    const updateEvent: SessionUpdateEvent = {
      type: 'session.update',
      event_id: this.generateEventId(),
      session: {
        instructions: updatedInstructions
      }
    };

    this.sendRealtimeEvent(updateEvent);
    console.log('Session update event sent');
  }

  /**
   * ユーザー応答の生成要求
   */
  createResponse(modalities: string[] = ['text', 'audio']): void {
    const responseEvent: ResponseCreateEvent = {
      type: 'response.create',
      event_id: this.generateEventId(),
      response: {
        modalities
      }
    };

    this.sendRealtimeEvent(responseEvent);
  }

  /**
   * 音声入力のキャンセル
   */
  cancelResponse(): void {
    this.sendRealtimeEvent({
      type: 'response.cancel',
      event_id: this.generateEventId()
    });
  }

  /**
   * セッションの状態取得
   */
  getSessionStatus(): {
    state: 'disconnected' | 'connecting' | 'connected' | 'error';
    session: RealtimeSession | null;
    consultantId: string | null;
    phase: 'questions' | 'hot-reading' | 'cold-reading' | 'subsidies' | 'summary' | 'recommendations';
    isConnected: boolean;
  } {
    return {
      state: this.sessionState,
      session: this.currentSession,
      consultantId: this.consultantId,
      phase: this.conversationPhase,
      isConnected: this.webrtcManager.isConnected()
    };
  }

  /**
   * セッションの終了
   */
  async endSession(): Promise<void> {
    try {
      this.sessionState = 'disconnected';

      // 音声処理を停止
      if (this.audioProcessor) {
        await this.audioProcessor.cleanup();
        this.audioProcessor = null;
      }

      // WebRTC接続を終了
      await this.webrtcManager.cleanup();

      // 状態をリセット
      this.currentSession = null;
      this.consultantId = null;
      this.conversationPhase = 'questions';
      this.messageHistory = [];

      this.emit('sessionended', {});

    } catch (error) {
      this.emit('error', {
        type: 'session_end_error',
        message: error instanceof Error ? error.message : 'Failed to end session'
      });
    }
  }

  /**
   * イベントIDの生成
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 最新のユーザー音声転写を取得
   */
  getLastUserTranscript(): string {
    return this.lastUserTranscript;
  }

  /**
   * 最新のアシスタント音声転写を取得
   */
  getLastAssistantTranscript(): string {
    return this.lastAssistantTranscript;
  }

  // イベントエミッター機能
  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  private emit(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in RealtimeAPIClient event handler for ${event}:`, error);
        }
      });
    }
  }
}
