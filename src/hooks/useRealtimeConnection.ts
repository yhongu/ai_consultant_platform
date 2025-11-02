import { useState, useEffect, useCallback, useRef } from 'react';
import { RealtimeAPIClient } from '../services/RealtimeAPIClient';
import {
  ConsultingPhase,
  PhaseManager,
  RealtimeController,
  RealtimeAPITransport,
} from '../services/realtime';
import { RealtimeSession } from '../types/webrtc';

const DEFAULT_AGENT_PHASE: ConsultingPhase = 'deep_research';

const AGENT_PHASE_PROMPTS: Record<ConsultingPhase, string> = {
  deep_research: '開始・深掘りフェーズに移行してもよろしいですか？',
  mode_check: 'モード確認フェーズに移行してもよろしいですか？',
  consulting: 'コンサルティングフェーズに移行してもよろしいですか？',
  summary: 'サマリーフェーズに移行してもよろしいですか？',
};

const summarizeMessageHistory = (
  input: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>,
): string | null => {
  if (!input.length) return null;

  const recent = input.slice(-10);
  const lines = recent
    .map((msg) => {
      const speaker = msg.role === 'user' ? 'ユーザー' : 'アシスタント';
      const text = msg.content.replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const truncated = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      return `${speaker}: ${truncated}`;
    })
    .filter((line): line is string => Boolean(line));

  if (!lines.length) return null;
  return lines.join('\n');
};

interface RealtimeConnectionState {
  // 接続状態
  isConnected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';

  // セッション情報
  session: RealtimeSession | null;
  consultantId: string | null;

  // 音声状態
  isMuted: boolean;
  isRemoteMuted: boolean;
  audioLevel: number;
  isVoiceActive: boolean;

  // 会話状態
  conversationPhase: 'questions' | 'hot-reading' | 'cold-reading' | 'subsidies' | 'summary' | 'recommendations';
  messageHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
  // 紹介カード（複数想定）
  recommendedIntroductions: any[];

  // エージェントフェーズ制御
  agentPhase: ConsultingPhase;
  pendingAgentPhase: ConsultingPhase | null;
  phaseTransitionStatus: 'idle' | 'awaiting_confirmation' | 'declined' | 'error';
  phaseTransitionAttempt: number;
  phaseTransitionReason?: string;
  phaseTransitionId: string | null;

  // エラー状態
  error: {
    type: string;
    message: string;
    suggestions?: string[];
  } | null;

  // フォールバック状態
  isFallbackMode: boolean;

  // イベントログ
  eventLog: Array<{
    timestamp: number;
    type: string;
    event_id?: string;
    event: any;
  }>;
}

interface RealtimeConnectionActions {
  // 接続制御
  connect: (consultantId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  retry: () => Promise<void>;

  // 音声制御
  toggleMute: () => void;
  toggleRemoteMute: () => void;
  setVolume: (volume: number) => void;
  switchToFallback: () => void;

  // 会話制御
  createResponse: () => void;
  cancelResponse: () => void;
  changePhase: (phase: RealtimeConnectionState['conversationPhase']) => void;
  requestAgentPhase: (phase: ConsultingPhase) => void;
  forceAgentPhase: (phase: ConsultingPhase) => Promise<void>;

  // バッファ制御
  commitAudioBuffer: () => void;
  clearAudioBuffer: () => void;

  // デバッグ
  clearError: () => void;
  clearEventLog: () => void;
}

export interface UseRealtimeConnectionReturn {
  state: RealtimeConnectionState;
  actions: RealtimeConnectionActions;
}

export const useRealtimeConnection = (): UseRealtimeConnectionReturn => {
  // RealtimeAPIClient のインスタンス
  const clientRef = useRef<RealtimeAPIClient | null>(null);
  const controllerRef = useRef<RealtimeController | null>(null);
  const phaseManagerRef = useRef<PhaseManager | null>(null);
  const transportRef = useRef<RealtimeAPITransport | null>(null);
  const lastConsultantIdRef = useRef<string | null>(null);
  // 紹介データのキャッシュ
  const introductionsCacheRef = useRef<any[] | null>(null);
  const loadIntroductions = useCallback(async () => {
    // キャッシュが未設定 or 空配列ならロードを試みる
    if (!introductionsCacheRef.current || introductionsCacheRef.current.length === 0) {
      try {
        const res = await fetch('/api/introductions');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        introductionsCacheRef.current = Array.isArray(data?.records) ? data.records : [];
        console.log('🧪 introductions fetched via /api/introductions:', introductionsCacheRef.current.length);
      } catch (err) {
        console.warn('⚠️ fetch /api/introductions failed. Falling back to bundled JSON.', err);
        try {
          const data = await import('../..//data/introductions_network.json');
          const records = (data as any)?.default?.records || (data as any)?.records || [];
          introductionsCacheRef.current = Array.isArray(records) ? records : [];
          console.log('🧪 introductions loaded via import fallback:', introductionsCacheRef.current.length);
        } catch (e) {
          console.error('❌ Failed to load introductions from local JSON as well:', e);
          introductionsCacheRef.current = [];
        }
      }
    } else {
      console.log('🧪 introductions using cached:', introductionsCacheRef.current.length);
    }
    console.log('🧪 introductions final size:', introductionsCacheRef.current.length);
    return introductionsCacheRef.current!;
  }, []);


  // 状態管理
  const [state, setState] = useState<RealtimeConnectionState>({
    isConnected: false,
    connectionState: 'disconnected',
    session: null,
    consultantId: null,
    isMuted: false,
    isRemoteMuted: false,
    audioLevel: 0,
    isVoiceActive: false,
    conversationPhase: 'questions',
    messageHistory: [],
    recommendedIntroductions: [],
    agentPhase: DEFAULT_AGENT_PHASE,
    pendingAgentPhase: null,
    phaseTransitionStatus: 'idle',
    phaseTransitionAttempt: 0,
    phaseTransitionReason: undefined,
    phaseTransitionId: null,
    error: null,
    isFallbackMode: false,
    eventLog: []
  });

  const teardownRealtimePipeline = useCallback(async () => {
    phaseManagerRef.current?.dispose();
    phaseManagerRef.current = null;

    if (controllerRef.current) {
      try {
        await controllerRef.current.cleanup();
      } catch (error) {
        console.warn('⚠️ Failed to cleanup RealtimeController:', error);
      }
      controllerRef.current = null;
    }

    transportRef.current = null;
    clientRef.current = null;

    setState(prev => ({
      ...prev,
      isConnected: false,
      connectionState: 'disconnected',
      session: null,
      consultantId: null,
      conversationPhase: 'questions',
      messageHistory: [],
      recommendedIntroductions: [],
      agentPhase: DEFAULT_AGENT_PHASE,
      pendingAgentPhase: null,
      phaseTransitionStatus: 'idle',
      phaseTransitionAttempt: 0,
      phaseTransitionReason: undefined,
      phaseTransitionId: null,
    }));
  }, [setState]);

  const setupRealtimePipeline = useCallback((client: RealtimeAPIClient) => {
    const transport = new RealtimeAPITransport(client);
    transportRef.current = transport;

    const controller = new RealtimeController(transport, {
      promptBuilder: (phase) =>
        AGENT_PHASE_PROMPTS[phase] ?? '次のフェーズに移行していいですか？',
      voice: 'alloy',
      includeTextModalities: true,
    });
    controllerRef.current = controller;

    const manager = new PhaseManager(controller, {
      initialPhase: DEFAULT_AGENT_PHASE,
      voice: 'alloy',
      includeTextModalities: true,
      promptBuilder: (phase) =>
        AGENT_PHASE_PROMPTS[phase] ?? '次のフェーズに移行していいですか？',
      onTransitionRequested: ({ phaseCandidate, transitionId, attempt }) => {
        setState(prev => ({
          ...prev,
          pendingAgentPhase: phaseCandidate,
          phaseTransitionStatus: 'awaiting_confirmation',
          phaseTransitionAttempt: attempt,
          phaseTransitionReason: undefined,
          phaseTransitionId: transitionId,
        }));
      },
      onPhaseChanged: ({ current, transitionId, metadata }) => {
        setState(prev => ({
          ...prev,
          agentPhase: current,
          pendingAgentPhase: null,
          phaseTransitionStatus: 'idle',
          phaseTransitionAttempt: 0,
          phaseTransitionReason: undefined,
          phaseTransitionId: transitionId,
        }));
        const shouldReset = transitionId === 'forced' || metadata?.forced === true;
        const shouldSkip = metadata?.forced === true;
        if (!shouldSkip && clientRef.current) {
          clientRef.current
            .setAgentPhase(current, {
              resetConversation: shouldReset,
            })
            .catch((error: unknown) => {
              console.warn('Failed to propagate agent phase to RealtimeAPIClient:', error);
            });
        }
      },
      onTransitionDeclined: ({ phaseCandidate, transitionId, reason }) => {
        setState(prev => ({
          ...prev,
          pendingAgentPhase: phaseCandidate,
          phaseTransitionStatus: 'declined',
          phaseTransitionAttempt: 0,
          phaseTransitionReason: reason,
          phaseTransitionId: transitionId,
        }));
      },
      onTransitionError: ({ phaseCandidate, transitionId, error }) => {
        setState(prev => ({
          ...prev,
          pendingAgentPhase: phaseCandidate,
          phaseTransitionStatus: 'error',
          phaseTransitionAttempt: 0,
          phaseTransitionReason:
            error instanceof Error ? error.message : String(error),
          phaseTransitionId: transitionId,
        }));
      },
    });
    phaseManagerRef.current = manager;

    setState(prev => ({
      ...prev,
      agentPhase: DEFAULT_AGENT_PHASE,
      pendingAgentPhase: null,
      phaseTransitionStatus: 'idle',
      phaseTransitionAttempt: 0,
      phaseTransitionReason: undefined,
      phaseTransitionId: null,
    }));
  }, [setState]);

  // イベントリスナーの設定
  const setupEventListeners = useCallback((client: RealtimeAPIClient) => {
    // 接続状態の変化
    client.on('sessioninitializing', () => {
      setState(prev => ({ ...prev, connectionState: 'connecting' }));
    });

    client.on('connected', () => {
      setState(prev => ({
        ...prev,
        isConnected: true,
        connectionState: 'connected',
        error: null
      }));
    });

    client.on('connectionfailed', () => {
      setState(prev => ({
        ...prev,
        isConnected: false,
        connectionState: 'error'
      }));
    });

    client.on('sessioninitialized', (data: any) => {
      setState(prev => ({
        ...prev,
        session: data.session,
        consultantId: data.consultantId
      }));
    });

    client.on('sessionended', () => {
      setState(prev => ({
        ...prev,
        isConnected: false,
        connectionState: 'disconnected',
        session: null,
        consultantId: null,
        conversationPhase: 'questions',
        messageHistory: [],
        recommendedIntroductions: [],
        agentPhase: DEFAULT_AGENT_PHASE,
        pendingAgentPhase: null,
        phaseTransitionStatus: 'idle',
        phaseTransitionAttempt: 0,
        phaseTransitionReason: undefined,
        phaseTransitionId: null,
      }));
    });

    // 音声関連イベント
    client.on('audiolevel', (data: any) => {
      setState(prev => ({
        ...prev,
        audioLevel: data.level,
        isVoiceActive: data.isActive
      }));
    });

    client.on('mutedstatechanged', (data: any) => {
      setState(prev => ({ ...prev, isMuted: data.muted }));
    });

    client.on('remoteaudiomutedchanged', (data: any) => {
      setState(prev => ({ ...prev, isRemoteMuted: data.muted }));
    });

    // 会話フェーズの変化
    client.on('phasechanged', (data: any) => {
      setState(prev => ({ ...prev, conversationPhase: data.phase }));
    });

    // メッセージ履歴の更新
    client.on('messagehistoryupdated', (data: any) => {
      setState(prev => ({
        ...prev,
        messageHistory: client.getMessageHistory()
      }));
    });

    // 音声転写イベント
    client.on('usertranscript', (data: any) => {
      setState(prev => ({
        ...prev,
        messageHistory: client.getMessageHistory()
      }));
    });

    client.on('assistanttranscript', (data: any) => {
      setState(prev => ({
        ...prev,
        messageHistory: client.getMessageHistory()
      }));
    });

    // RECOタグからの推薦受信 → 紹介カードに反映（追加・重複排除）
    client.on('recommendationssuggested', async (data: { ids: string[] }) => {
      try {
        const ids = Array.isArray(data?.ids) ? data.ids : [];
        console.log('🧪 recommendationssuggested event received. ids =', ids);
        if (ids.length === 0) return;
        const records = await loadIntroductions();
        console.log('🧪 introductions records loaded:', Array.isArray(records) ? records.length : 0);
        const idSet = new Set(ids);
        const matched = records.filter((r: any) => {
          const name = r?.company?.name;
          const alias = r?.company?.alias;
          return (name && idSet.has(name)) || (alias && idSet.has(alias));
        });
        console.log('🧪 matched introductions count:', matched.length, matched.map((m: any) => m?.company?.name));
        if (matched.length === 0) return;
        setState(prev => {
          const existing = prev.recommendedIntroductions || [];
          const keyOf = (r: any) => `${r?.company?.name || ''}::${r?.company?.alias || ''}`;
          const map = new Map(existing.map((r: any) => [keyOf(r), r]));
          matched.forEach((r: any) => map.set(keyOf(r), r));
          const next = Array.from(map.values());
          console.log('🧪 recommendedIntroductions updated. size =', next.length);
          return { ...prev, recommendedIntroductions: next };
        });
      } catch (e) {
        console.warn('⚠️ Failed to update recommendations:', e);
      }
    });

    // エラーハンドリング
    client.on('error', (errorData: any) => {
      setState(prev => ({
        ...prev,
        error: {
          type: errorData.type,
          message: errorData.message,
          suggestions: errorData.suggestions
        },
        connectionState: 'error'
      }));
    });

    client.on('realtimeapierror', (errorData: any) => {
      setState(prev => ({
        ...prev,
        error: {
          type: 'realtime_api_error',
          message: errorData.message,
          suggestions: []
        }
      }));
    });

    // イベントログ
    client.on('eventlog', (data: any) => {
      setState(prev => ({
        ...prev,
        eventLog: [...prev.eventLog.slice(-99), data] // 最新100件まで保持
      }));
    });

    // フォールバック関連（今後実装）
    client.on('fallbackmodeactivated', () => {
      setState(prev => ({ ...prev, isFallbackMode: true }));
    });

  }, [loadIntroductions]);

  // RealtimeAPIClientの生成
  const createRealtimeClient = useCallback(() => {
    const client = new RealtimeAPIClient({
      tokenServiceUrl: '/session',
      enableFallback: true
    });

    setupEventListeners(client);
    return client;
  }, [setupEventListeners]);

  // 接続

  const connect = useCallback(async (consultantId: string) => {
    console.log('=== useRealtimeConnection connect called ===');
    console.log('Consultant ID:', consultantId);

    try {
      await teardownRealtimePipeline();

      console.log('Initializing client...');
      const client = createRealtimeClient();
      clientRef.current = client;
      setupRealtimePipeline(client);
      lastConsultantIdRef.current = consultantId;

      console.log('Setting connection state to connecting...');
      setState(prev => ({
        ...prev,
        connectionState: 'connecting',
        error: null,
        agentPhase: DEFAULT_AGENT_PHASE,
        pendingAgentPhase: null,
        phaseTransitionStatus: 'idle',
        phaseTransitionAttempt: 0,
        phaseTransitionReason: undefined,
        phaseTransitionId: null,
      }));

      const controller = controllerRef.current;
      if (!controller) {
        throw new Error('Realtime controller is not initialized');
      }

      console.log('About to call controller.connect...');
      await controller.connect({ consultantId });
      console.log('controller.connect completed');
    } catch (error) {
      console.error('Failed to establish realtime session:', error);
      setState(prev => ({
        ...prev,
        connectionState: 'error',
        error: {
          type: 'connection_error',
          message: error instanceof Error ? error.message : '接続に失敗しました',
          suggestions: ['ネットワーク接続を確認してください', '再度お試しください']
        }
      }));
      await teardownRealtimePipeline();
    }
  }, [createRealtimeClient, setupRealtimePipeline, teardownRealtimePipeline]);

  // 切断
  const disconnect = useCallback(async () => {
    await teardownRealtimePipeline();
  }, [teardownRealtimePipeline]);

  // 再接続
  const retry = useCallback(async () => {
    if (lastConsultantIdRef.current) {
      await connect(lastConsultantIdRef.current);
    }
  }, [connect]);

  // ミュート切り替え
  const toggleMute = useCallback(() => {
    if (clientRef.current) {
      const newMutedState = !state.isMuted;
      // WebRTCManagerのsetMutedメソッドを呼び出す
      (clientRef.current as any).webrtcManager?.setMuted(newMutedState);
    }
  }, [state.isMuted]);

  // リモート音声ミュート切り替え
  const toggleRemoteMute = useCallback(() => {
    if (clientRef.current) {
      const newMutedState = !state.isRemoteMuted;
      (clientRef.current as any).webrtcManager?.setRemoteAudioMuted(newMutedState);
    }
  }, [state.isRemoteMuted]);

  // 音量設定
  const setVolume = useCallback((volume: number) => {
    if (clientRef.current) {
      (clientRef.current as any).webrtcManager?.setRemoteAudioVolume(volume);
    }
  }, []);

  // フォールバックモードへの切り替え
  const switchToFallback = useCallback(() => {
    setState(prev => ({ ...prev, isFallbackMode: true }));
    // TODO: 実際のフォールバック処理を実装
  }, []);

  // レスポンス作成
  const createResponse = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.createResponse(['text', 'audio']);
    }
  }, []);

  // レスポンスキャンセル
  const cancelResponse = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.cancelResponse();
    }
  }, []);

  // フェーズ変更
  const changePhase = useCallback((phase: RealtimeConnectionState['conversationPhase']) => {
    if (clientRef.current) {
      clientRef.current.forcePhaseTransition(phase);
    }
  }, []);

  const requestAgentPhase = useCallback((phase: ConsultingPhase) => {
    phaseManagerRef.current?.requestTransition(phase);
  }, []);

  const forceAgentPhase = useCallback(
    async (phase: ConsultingPhase): Promise<void> => {
      if (!state.consultantId) {
        return;
      }

      const summary = summarizeMessageHistory(state.messageHistory);
      const consultantId = state.consultantId;

      try {
        await teardownRealtimePipeline();

        const client = createRealtimeClient();
        clientRef.current = client;
        setupRealtimePipeline(client);
        client.setSessionSummary(summary);
        client.primeAgentPhase(phase, { resetConversation: true });
        lastConsultantIdRef.current = consultantId;

        setState(prev => ({
          ...prev,
          connectionState: 'connecting',
          isConnected: false,
          error: null,
          agentPhase: phase,
          pendingAgentPhase: null,
          phaseTransitionStatus: 'idle',
          phaseTransitionAttempt: 0,
          phaseTransitionReason: undefined,
          phaseTransitionId: null,
        }));

        await client.initializeSession(consultantId);
        await client.setAgentPhase(phase, { resetConversation: true });
        await client.simulateUserContinuation();
        await client.sendPhaseKickoffPrompt(phase);

        phaseManagerRef.current?.forceTransition(phase);
      } catch (error) {
        console.error('Failed to restart session with new phase:', error);
        setState(prev => ({
          ...prev,
          connectionState: 'error',
          error: {
            type: 'connection_error',
            message:
              error instanceof Error
                ? error.message
                : 'フェーズ再適用に失敗しました',
            suggestions: ['ネットワーク状況を確認してください', '再度フェーズ切替をお試しください'],
          },
        }));
      }
    },
    [createRealtimeClient, setupRealtimePipeline, state.consultantId, state.messageHistory, teardownRealtimePipeline],
  );

  // 音声バッファ操作
  const commitAudioBuffer = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.commitAudioBuffer();
    }
  }, []);

  const clearAudioBuffer = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.clearAudioBuffer();
    }
  }, []);

  // エラークリア
  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  // イベントログクリア
  const clearEventLog = useCallback(() => {
    setState(prev => ({ ...prev, eventLog: [] }));
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      teardownRealtimePipeline().catch(() => {
        // no-op: クリーンアップ失敗時は無視
      });
    };
  }, [teardownRealtimePipeline]);

  // アクション集約
  const actions: RealtimeConnectionActions = {
    connect,
    disconnect,
    retry,
    toggleMute,
    toggleRemoteMute,
    setVolume,
    switchToFallback,
    createResponse,
    cancelResponse,
    changePhase,
    requestAgentPhase,
    forceAgentPhase,
    commitAudioBuffer,
    clearAudioBuffer,
    clearError,
    clearEventLog
  };

  return { state, actions };
};
