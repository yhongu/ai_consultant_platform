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
import { ConsultingPhase } from './realtime';

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
  private shouldInjectResetPrompt: boolean = false;
  private agentPhase: ConsultingPhase = 'deep_research';
  private sessionSummary: string | null = null;

  constructor(options: Partial<WebRTCManagerOptions> = {}) {
    // WebRTCManagerを初期化
    this.webrtcManager = new WebRTCManager(options);
    this.tokenManager = new EphemeralTokenManager(options.tokenServiceUrl || '/session');
    
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

    const phaseInstruction = this.getAgentPhaseInstruction(this.agentPhase);
    const resetInstruction = this.shouldInjectResetPrompt
      ? '今までの流れは一度忘れてください。必ず以下の手順1から会話を再開してください。\n\n'
      : '';
    const summarySection = this.sessionSummary
      ? `#前回までの要約\n${this.sessionSummary}\n\n`
      : '';

    const instruction = `
あなたは「${consultant.name}」として振る舞います。

「#基本方針」と「#コンサル手順」に従って、コンサルタントをすること。

#基本方針
- 返信は日本語で100字以内・完結文。
- 「手順」は止まることなく続行してください。1つの手順は1回の発言で必ず終了して次の手順に移行してください。
- 信頼の二軸を同時に獲得：「人として信頼」＋「プロとして信頼」。
- 専門語には必ず平易補足を添える、売り込み禁止。
- 短く・具体・やさしく。相手の時間を節約する表現を最優先。押し売りしない。
- 相手が「相談は終わり」「相談は終了」などと言ったら、それまでの情報を元に最適な人材を紹介する ##手順7 を実行してください。

${summarySection}#現在のオペレーションフェーズ
${resetInstruction}${phaseInstruction}

#コンサル手順
- フェーズ指示に従い、適切なヒアリングと提案を行ってください。

#出力フォーマット（厳守）
- 紹介を行うときは、必ず「2つの出力アイテム」を連続して生成する。
  1) 会話本文（自然な話し言葉）。これは audio を伴う。タグ語（RECO/タグ/JSON/角括弧 等）を本文に一切含めない。
  2) テキストのみのメタ情報メッセージ。内容は厳密に1行のみ、余計な文字なしで <RECO>{"ids":[...]}</RECO> とする（audio は生成しない）。JSON は最小表記（スペース無し）。
`;

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
  private getAgentPhaseInstruction(phase: ConsultingPhase): string {
    switch (phase) {
      case 'deep_research':
        return `### 開始・深掘りフェーズ

            文脈が以下の手順のどこでもない場合は以下の手順1からスタートしてください。

            #会話の進行手順
            ##手順1: 「本日はどのようなことをお話したいですか？」と聞く
            ##手順2: 業界、事業規模、従業員数を聞く
            ##手順3: 既存の取引先さんはどんなところかを聞く
            ##手順4: 目的確認と許可取りをとって次のフェーズへ進む。「今日は御社の課題整理をさせていただき、最適案の合意まで進めても良いですか？」
        `;

      case 'mode_check':
        return `### モード確認フェーズ

            文脈が以下の手順のどこでもない場合は以下の手順1からスタートしてください。

            #会話の進行手順
            ##手順1: 今までのヒアリング内容をまとめる
            ##手順2: 「今日はオペレーションモードと相談モードどちらになさいますか？」と聞く
            ##手順3: 相談内容と選択したモードを最終確認する。
        `;

      case 'consulting':
        return `### コンサルフェーズ
            文脈が以下の手順のどこでもない場合は以下の手順1からスタートしてください。

            #会話の進行手順
            ##手順1. 抽象化する。（Whyを掘る）
              - 以下は発話例
              - 「そもそもなぜ税理士を探しているのですか？」
              - 「これまでの関係で物足りなかった点はどこでしょう？」

            ##手順2. 共感・リフレーミングする。感情を言語化し、上位概念で整理する
              - 以下は発話例
              - 「数字の処理はしてもらえても、“経営の味方”ではなかったんですね。」
              - 「節税だけでなく、“利益設計と資金設計”を一緒に考えたいということですね。」

            ##手順3. 構造化する。（Howを形に）ニーズを具体化し、分類軸を提示する。
              - 以下は発話例
              - 「補助金や助成金の提案も含めたトータルサポートがあると理想ですか？」

            ##手順4. タイプ整理（知識提示）
              - 以下は発話例
              - 「税理士にもタイプがありまして、“節税特化型”と“財務思考型”があります。
                  現在の状況ですと、経営全体を見てくれる“財務思考型”が向いていると思います。」

            ##手順5. まとめ・確認
              - 以下は発話例
              - 「つまり、今お求めなのは“資金繰りや成長を一緒に考えてくれる税理士”という理解で合っていますか？」


            ## 4. 専門知識（税理士評価の軸）

            | 観点 | 要点 |
            |------|------|
            | 財務 × 税務のバランス | 節税だけでなく、融資評価を下げない決算設計ができるか |
            | 税務調査対応 | 形式よりも「どのように関わるか」を説明できるか |
            | 融資・資金計画支援 | 銀行交渉・キャッシュフロー計画まで支援できるか |
            | 事業承継支援 | “資産承継”ではなく“経営承継”視点を持つか |
            | 補助金・助成金対応 | 提案・申請・法認定の一連をサポートできるか |

            **対話例：**

            AI「はい、では相談モードで進めますね。  
            そもそもなぜ税理士を探しているんですか？」

            ユーザー「今の人は決算と申告だけで、経営の話まではしてくれなくて。」

            AI「なるほど。数字は見てもらえるけど、“経営の味方”という感じではなかったんですね。」

            AI「最終的にどうなっていたいですか？安心して任せたい、それとも一緒に成長を考えるパートナーを求めている感じですか？」

            ユーザー「パートナーとして支えてほしいです。」

            AI「素晴らしいですね。“税務処理”ではなく“利益設計と資金設計”を見てくれる税理士ですね。
            このタイプを選ぶと、融資や補助金の相談も同時に進めやすいです。」



        
        `;

      case 'summary':
      default:
        return `### サマリーフェーズ

          文脈が以下の手順のどこでもない場合は以下の手順1からスタートしてください。

            #### 手順1. サマリー作成
            - 対話を基に、ユーザーの課題を4点以内に要約する。
            - 例：
              - 財務と税務の両立が必要
              - 融資・補助金に強い
              - クラウドでスピーディに連携できる
              - 経営に踏み込む姿勢がある

            #### 手順2. 紹介判定
            - 以下の「紹介先リスト」を検索。
            - 条件マッチ度（地域・専門性・相性）を判定。
            - 紹介候補がいる場合：
              - 例：
                私から2名ほどマッチする税理士候補をご紹介可能です。
                ・総合FP資産形成・コンサルティング株式会社　上實 貴一さん
                ・株式会社Oneplat　泉 卓真さん
                初回面談は私も同席し、“経営の話ができるか”を一緒に確認しましょう。
            - 紹介候補がいない場合：
              - 例：
                現時点ではご紹介候補はいませんが、
                今日の内容をもとに次回までに整理すべきポイントをまとめました。
                → 課題サマリーを出力（次の行動指針を示す）
                
            #### 手順3. クロージング
            - 紹介時は必ず「伴走」意志を伝える。
            - 「経営の伴走者を求めている点が明確になりましたね」
            - 「良い出会いになるよう、全力でサポートします」

          ## ■会話トーン例

          - 「ここまでのお話を伺う限り、財務と税務の両立を重視されている印象です。」
          - 「なるほど、数字の処理だけでなく“経営の味方”を求めているんですね。」
          - 「私から2名ほどマッチする税理士候補をご紹介できます。」
          - 「もしピンと来なければ遠慮なくお断りください。次の選択肢を一緒に考えましょう。」
          - 「今日の話で“税務の人”ではなく“経営の伴走者”を求めていることが明確になりました。」


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


        - 紹介を行うときは、必ず「2つの出力アイテム」を連続して生成する。
          1) 会話本文（自然な話し言葉）。これは audio を伴う。タグ語（RECO/タグ/JSON/角括弧 等）を本文に一切含めない。
          2) テキストのみのメタ情報メッセージ。内容は厳密に1行のみ、余計な文字なしで <RECO>{"ids":[...]}</RECO> とする（audio は生成しない）。JSON は最小表記（スペース無し）。

        `;
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
      console.log('Instructions preview:', event.session.instructions + '...');
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
    console.log('Instructions preview:', updatedInstructions + '...');
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
    this.shouldInjectResetPrompt = false;
  }

  async setAgentPhase(
    phase: ConsultingPhase,
    options?: { resetConversation?: boolean },
  ): Promise<void> {
    const reset = options?.resetConversation ?? false;
    const phaseChanged = this.agentPhase !== phase;

    if (phaseChanged) {
      this.agentPhase = phase;
    }

    this.shouldInjectResetPrompt = reset;

    const shouldUpdate = (phaseChanged || reset) && this.consultantId && this.currentSession && this.sessionState === 'connected';

    if (shouldUpdate) {
      try {
        await this.updateSessionInstructions();
        if (reset) {
          await this.sendPhaseKickoffPrompt(this.agentPhase);
        }
      } catch (error) {
        console.error('Failed to update session instructions for new agent phase:', error);
      } finally {
        this.shouldInjectResetPrompt = false;
      }
    } else {
      this.shouldInjectResetPrompt = false;
    }
  }

  getAgentPhase(): ConsultingPhase {
    return this.agentPhase;
  }

  setSessionSummary(summary: string | null): void {
    this.sessionSummary = summary ? summary.trim() : null;
  }

  primeAgentPhase(
    phase: ConsultingPhase,
    options?: { resetConversation?: boolean },
  ): void {
    this.agentPhase = phase;
    this.shouldInjectResetPrompt = options?.resetConversation ?? false;
  }

  private getPhaseKickoffPrompt(phase: ConsultingPhase): string | null {
    switch (phase) {
      case 'deep_research':
        return 'では、まず現在の事業内容や課題を簡単に教えてください。';
      case 'mode_check':
        return 'ここまでの内容を簡単にまとめます。今日はオペレーションモードと相談モードのどちらで進めますか？';
      case 'consulting':
        return 'ここまでのお話を踏まえて、整理された課題と仮説を共有します。まずは大枠の論点からお伝えします。';
      case 'summary':
        return 'これまでの議論を要約します。重要なポイントを3つ程度に絞ってお伝えします。';
      default:
        return null;
    }
  }

  private async simulateUserContinuation(): Promise<void> {
    const event: RealtimeEvent = {
      type: 'conversation.item.create',
      event_id: this.generateEventId(),
      item: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '続けてお願いします。' },
        ],
      },
    };

    this.sendRealtimeEvent(event);
  }

  private async sendPhaseKickoffPrompt(phase: ConsultingPhase): Promise<void> {
    const prompt = this.getPhaseKickoffPrompt(phase);
    if (!prompt) return;

    const event: ResponseCreateEvent = {
      type: 'response.create',
      event_id: this.generateEventId(),
      response: {
        modalities: ['text', 'audio'],
        instructions: prompt,
      },
    };

    this.sendRealtimeEvent(event);
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
