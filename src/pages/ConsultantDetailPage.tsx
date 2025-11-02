import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { TalentCard } from '../components/TalentCard';
import { RealtimeVoiceControls } from '../components/RealtimeVoiceControls';
import { consultants } from '../data/consultants';
import { mockTalents, questionFlow, hotReadingResponses, coldReadingResponses, subsidyRecommendations, finalSummary, userResponses } from '../data/mockData';
import { Message, RealtimeMessage } from '../types';
import { Send, User, Bot, Mic, MicOff, Volume2, Phone, PhoneOff } from 'lucide-react';
import { useRealtimeConnection } from '../hooks/useRealtimeConnection';
import { ConsultingPhase } from '../services/realtime';

export const ConsultantDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  
  // WebRTC接続の状態管理
  const { state, actions } = useRealtimeConnection();
  
  // 既存の状態（フォールバック用）
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [subsidyIndex, setSubsidyIndex] = useState(0);
  const [audioIndex, setAudioIndex] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [hasSpokenWelcome, setHasSpokenWelcome] = useState(false);
  
  // UI状態
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [useWebRTC, setUseWebRTC] = useState(true); // WebRTC/フォールバック切り替え
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recoSectionRef = useRef<HTMLDivElement>(null);
  const prevRecoCountRef = useRef<number>(0);

  const consultant = consultants.find(c => c.id === id);

  // プロフィール画像のパスを設定（コンサルタントID=1の場合は専用画像を使用）
  const avatarPath = id === '1' ? '/IKariwUZ_400x400.jpg' : consultant?.avatar;

  // WebRTCまたはフォールバックの状態を統一
  const isConnected = useWebRTC ? state.isConnected : hasSpokenWelcome;
  const currentPhase = useWebRTC ? state.conversationPhase : getPhaseFromMessageCount();
  const currentMessages = useWebRTC ? convertRealtimeMessagesToMessages(state.messageHistory) : messages;

  const agentPhaseOptions: Array<{
    phase: ConsultingPhase;
    label: string;
    description: string;
  }> = [
    { phase: 'deep_research', label: '開始・深掘り', description: 'ヒアリングと仮説構築' },
    { phase: 'mode_check', label: 'モード確認', description: '意図確認と優先度整理' },
    { phase: 'consulting', label: 'コンサル', description: '分析と提案提示' },
    { phase: 'summary', label: 'サマリー', description: '会話の要約と次アクション' },
  ];

  const agentPhaseDisplay =
    agentPhaseOptions.find(option => option.phase === state.agentPhase)?.label ?? '未設定';
  const pendingPhaseLabel = state.pendingAgentPhase
    ? agentPhaseOptions.find(option => option.phase === state.pendingAgentPhase)?.label
    : undefined;
  const transitionStatusMessage = (() => {
    switch (state.phaseTransitionStatus) {
      case 'awaiting_confirmation':
        return pendingPhaseLabel
          ? `「${pendingPhaseLabel}」への移行をユーザーに確認中...（試行 ${state.phaseTransitionAttempt}）`
          : 'ユーザー確認中...';
      case 'declined':
        return pendingPhaseLabel
          ? `「${pendingPhaseLabel}」への移行はユーザーに拒否されました`
          : 'ユーザーがフェーズ移行を拒否しました';
      case 'error':
        return 'フェーズ移行中にエラーが発生しました';
      default:
        return '';
    }
  })();
  const canRequestAgentPhase =
    state.isConnected && state.connectionState === 'connected';

  // ヘルパー関数: メッセージ数からフェーズを推測
  function getPhaseFromMessageCount(): 'questions' | 'hot-reading' | 'cold-reading' | 'subsidies' | 'summary' | 'recommendations' {
    if (messages.length <= 6) return 'questions';
    if (messages.length <= 10) return 'hot-reading';
    if (messages.length <= 14) return 'cold-reading';
    if (messages.length <= 18) return 'subsidies';
    if (messages.length <= 20) return 'summary';
    return 'recommendations';
  }

  // ヘルパー関数: RealtimeメッセージをMessageに変換
  function convertRealtimeMessagesToMessages(realtimeHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>): Message[] {
    return realtimeHistory.map((msg, index) => ({
      id: `realtime-${index}`,
      type: msg.role === 'user' ? 'user' : 'consultant',
      // 念のためUI側でも <RECO>…</RECO> を除去
      content: String(msg.content).replace(/<RECO>[\s\S]*?<\/RECO>/g, '').trim(),
      timestamp: new Date(msg.timestamp),
      isAudio: msg.role === 'assistant'
    }));
  }

  // WebRTC接続開始
  const handleStartWebRTCCall = async () => {
    console.log('=== handleStartWebRTCCall called ===');
    console.log('Consultant ID from params:', id);
    
    if (!id) {
      console.log('❌ No consultant ID found');
      return;
    }
    
    try {
      console.log('🔄 About to call actions.connect with ID:', id);
      await actions.connect(id);
      console.log('✅ actions.connect completed successfully');
    } catch (error) {
      console.error('WebRTC接続エラー:', error);
      // エラー時はフォールバックモードに切り替え
      setUseWebRTC(false);
      handleStartCall(); // 既存のフォールバック処理
    }
  };

  // 通話終了（WebRTC）
  const handleEndWebRTCCall = async () => {
    await actions.disconnect();
  };

  // フォールバックモードへの切り替え
  const handleSwitchToFallback = () => {
    setUseWebRTC(false);
    actions.clearError();
    // フォールバック開始
    if (!hasSpokenWelcome) {
      handleStartCall();
    }
  };

  // 再接続試行
  const handleRetryConnection = async () => {
    if (state.error) {
      actions.clearError();
    }
    await actions.retry();
  };

  const handleAgentPhaseRequest = (phase: ConsultingPhase) => {
    if (!canRequestAgentPhase) return;
    actions.requestAgentPhase(phase);
  };

  const handleForceAgentPhase = (phase: ConsultingPhase) => {
    void actions.forceAgentPhase(phase);
  };

  const handleImmediateAgentPhase = (phase: ConsultingPhase) => {
    handleForceAgentPhase(phase);
  };

  // 音声ファイルを再生する関数
  const playAudioFile = (audioNumber?: number) => {
    const currentAudioIndex = audioNumber || audioIndex;
    const audioFileName = `${currentAudioIndex.toString().padStart(3, '0')}.wav`;
    const audioPath = `/${audioFileName}`;
    
    console.log('音声ファイル再生開始:', audioPath, 'currentAudioIndex:', currentAudioIndex);
    
    // 既存の音声を停止
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    
    // 新しい音声を作成して再生
    const audio = new Audio(audioPath);
    audioRef.current = audio;
    
    audio.onloadstart = () => {
      console.log('音声ファイル読み込み開始');
      setIsSpeaking(true);
    };
    
    audio.onended = () => {
      console.log('音声ファイル再生終了');
      setIsSpeaking(false);
    };
    
    audio.onerror = (event) => {
      console.error('音声ファイル再生エラー:', event);
      setIsSpeaking(false);
    };
    
    audio.play().catch(error => {
      console.error('音声再生に失敗:', error);
      setIsSpeaking(false);
    });
  };

  // 音声を停止する関数
  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      console.log('音声再生を停止しました');
      setIsSpeaking(false);
    }
  };

  const handleStartCall = () => {
    console.log('通話開始 - 初回音声再生');
    playAudioFile(1);
  };

  // 初回メッセージと音声再生
  useEffect(() => {
    if (consultant && messages.length === 0 && !hasSpokenWelcome) {
      console.log('初回メッセージを設定中...');
      // 初回の挨拶メッセージ
      const welcomeMessage: Message = {
        id: '1',
        type: 'consultant',
        content: `${questionFlow[0]}`,
        timestamp: new Date(),
        isAudio: true
      };
      setMessages([welcomeMessage]);
      setHasSpokenWelcome(true);
    }
  }, [consultant, messages.length, hasSpokenWelcome]);

  // 紹介カードが新たに表示されたら、そのセクションへ自動スクロール
  useEffect(() => {
    const count = Array.isArray(state.recommendedIntroductions)
      ? state.recommendedIntroductions.length
      : 0;
    if (count > 0 && count > prevRecoCountRef.current) {
      // 新規にカードが増えたときのみスクロール
      recoSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    prevRecoCountRef.current = count;
  }, [state.recommendedIntroductions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = (content: string) => {
    if (!content.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content,
      timestamp: new Date(),
      isAudio: false
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');

    // 次の音声ファイルのインデックスを更新
    setAudioIndex(prev => prev + 1);

    // AIの応答を生成
    setTimeout(() => {
      generateAIResponse();
    }, 1000);
  };

  const generateAIResponse = () => {
    let responseContent = '';

    if (phase === 'questions') {
      if (currentQuestionIndex < questionFlow.length - 1) {
        const nextIndex = currentQuestionIndex + 1;
        responseContent = questionFlow[nextIndex];
        setCurrentQuestionIndex(nextIndex);
      } else {
        // 質問フェーズ終了、ホットリーディングへ
        responseContent = hotReadingResponses[Math.floor(Math.random() * hotReadingResponses.length)];
        setPhase('hot-reading');
      }
    } else if (phase === 'hot-reading') {
      responseContent = coldReadingResponses[Math.floor(Math.random() * coldReadingResponses.length)];
      setPhase('cold-reading');
    } else if (phase === 'cold-reading') {
      responseContent = subsidyRecommendations[0];
      setPhase('subsidies');
      setSubsidyIndex(0);
    } else if (phase === 'subsidies') {
      if (subsidyIndex < subsidyRecommendations.length - 1) {
        const nextIndex = subsidyIndex + 1;
        responseContent = subsidyRecommendations[nextIndex];
        setSubsidyIndex(nextIndex);
      } else {
        responseContent = finalSummary;
        setPhase('summary');
      }
    } else if (phase === 'summary') {
      responseContent = 'それでは、あなたの課題解決に最適な人材をご紹介させていただきます。以下の方々がおすすめです。';
      setPhase('recommendations');
    } else if (phase === 'cold-reading') {
      responseContent = 'それでは、あなたの課題解決に最適な人材をご紹介させていただきます。以下の方々がおすすめです。';
      setPhase('recommendations');
    }

    const aiMessage: Message = {
      id: Date.now().toString(),
      type: 'consultant',
      content: responseContent,
      timestamp: new Date(),
      isAudio: true
    };

    setMessages(prev => [...prev, aiMessage]);

    // AIの応答を音声で読み上げ
    const nextAudioIndex = audioIndex + 1;
    setAudioIndex(nextAudioIndex);
    setTimeout(() => {
      playAudioFile(nextAudioIndex);
    }, 800);
  };

  const handleVoiceInput = () => {
    setIsRecording(true);
    // モック: 2秒後に音声入力を終了し、サンプルテキストを返す
    setTimeout(() => {
      setIsRecording(false);
      // 現在のフェーズに応じた適切な回答を返す
      let response = '';
      if (phase === 'questions' && currentQuestionIndex < userResponses.length) {
        response = userResponses[currentQuestionIndex];
      } else {
        response = "とても参考になります！まずは『ものづくり補助金』の申請書作成に取りかかります。";
      }
      handleSendMessage(response);
    }, 2000);
  };

  if (!consultant) {
    return (
      <Layout>
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold text-gray-900">コンサルタントが見つかりません</h1>
        </div>
      </Layout>
    );
  }

  // 最新のメッセージを取得
  const latestConsultantMessage = currentMessages
    .filter(m => m.type === 'consultant' && m.content.trim())
    .slice(-1)[0];
  const latestUserMessage = currentMessages
    .filter(m => m.type === 'user' && m.content.trim())
    .slice(-1)[0];

  return (
    <Layout fullscreen>
      {/* 全画面ダークUI */}
      <div className="min-h-screen relative overflow-hidden" style={{
        background: 'radial-gradient(circle at 50% 40%, #2563eb 0%, #1e3a8a 30%, #1e293b 60%, #0f172a 100%)'
      }}>
        {/* 左上: 小さなプロフィール */}
        <div className="absolute top-8 left-8 flex items-start space-x-2 z-10">
          <img
            src={avatarPath}
            alt={consultant.name}
            className="w-10 h-10 rounded-full object-cover border-2 border-white shadow-lg"
          />
          <div className="text-white leading-tight">
            <div className="text-[11px]">五味田 匡功</div>
          </div>
        </div>

        {/* 中央: 大きなプロフィール画像と名前 */}
        <div className="absolute top-28 left-1/2 transform -translate-x-1/2 flex flex-col items-center z-10">
          {/* 単一円のプロフィール画像 */}
          <img
            src={avatarPath}
            alt={consultant.name}
            className="w-60 h-60 rounded-full object-cover border-[6px] border-white shadow-2xl"
          />
          <div className="mt-5 text-center">
            <h1 className="text-3xl font-bold text-white tracking-wide">{consultant.name}</h1>
            <p className="text-sm text-gray-200 mt-2">レリック社労士法人代表</p>
          </div>
        </div>

        {/* 左側: コンサルタントのメッセージ（白い吹き出し） - メッセージがある場合のみ表示 */}
        {latestConsultantMessage && (
          <div className="absolute left-8 top-[45%] transform -translate-y-1/2 max-w-xs z-10">
            <div className="mb-2 text-white text-xs">{consultant.name}</div>
            <div className="bg-white rounded-2xl p-5 shadow-2xl">
              <p className="text-gray-800 leading-relaxed text-xs">
                {latestConsultantMessage.content}
              </p>
            </div>
          </div>
        )}

        {/* 右下: ユーザーのメッセージ（白い吹き出し） - メッセージがある場合のみ表示 */}
        {latestUserMessage && (
          <div className="absolute bottom-44 right-12 max-w-[280px] z-10">
            <div className="text-right mb-2">
              <span className="text-white text-sm">山田 太郎</span>
            </div>
            <div className="bg-white rounded-2xl p-4 shadow-2xl">
              <p className="text-gray-800 leading-relaxed text-xs">
                {latestUserMessage.content}
              </p>
            </div>
          </div>
        )}

        {/* フェーズ制御パネル */}
        {useWebRTC && (
          <div className="absolute bottom-40 left-8 w-80 z-10">
            <div className="bg-white/95 backdrop-blur-md border border-white/60 rounded-2xl shadow-2xl p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">フェーズ制御</h3>
                <p className="text-xs text-gray-500 mt-1">
                  現在: <span className="font-medium text-gray-900">{agentPhaseDisplay}</span>
                </p>
                {transitionStatusMessage && (
                  <p className="text-xs text-indigo-600 mt-1">{transitionStatusMessage}</p>
                )}
                {state.phaseTransitionReason && (
                  <p className="text-xs text-red-600 mt-1">
                    理由: {state.phaseTransitionReason}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {agentPhaseOptions.map(option => {
                  const isCurrent = state.agentPhase === option.phase;
                  const isPending =
                    state.pendingAgentPhase === option.phase &&
                    state.phaseTransitionStatus === 'awaiting_confirmation';
                  return (
                    <div key={option.phase} className="relative">
                      <button
                        type="button"
                        onClick={() => handleAgentPhaseRequest(option.phase)}
                        disabled={!canRequestAgentPhase || isCurrent || isPending}
                        className={`w-full text-left text-xs px-3 py-2 rounded-lg border transition ${
                          isCurrent
                            ? 'bg-blue-600 text-white border-blue-600'
                            : isPending
                            ? 'bg-yellow-100 text-yellow-800 border-yellow-300 animate-pulse'
                            : 'bg-white text-gray-700 border-gray-200 hover:border-blue-400 hover:text-blue-600'
                        }`}
                      >
                        <span className="block font-semibold">{option.label}</span>
                        <span className="block text-[10px] mt-1 text-gray-500">
                          {option.description}
                        </span>
                      </button>
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => handleImmediateAgentPhase(option.phase)}
                          className="absolute top-2 right-2 text-[10px] text-gray-400 hover:text-gray-700 underline"
                        >
                          即時適用
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {state.phaseTransitionStatus === 'declined' && state.pendingAgentPhase && (
                <div className="flex items-center justify-end">
                  <button
                    onClick={() => handleForceAgentPhase(state.pendingAgentPhase as ConsultingPhase)}
                    className="text-[11px] text-red-600 hover:text-red-700 underline"
                  >
                    強制適用
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 下部中央: 3つのボタン */}
        <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2 flex items-center space-x-8 z-10">
          {/* Off ボタン */}
          <div className="flex flex-col items-center">
            <button
              onClick={actions.toggleMute}
              className="w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-xl bg-gray-600 hover:bg-gray-500"
            >
              <MicOff className="text-white" size={24} />
            </button>
            <span className="text-white text-xs mt-2 font-medium">Off</span>
          </div>

          {/* On ボタン（中央・大きめ） */}
          <div className="flex flex-col items-center">
            <button
              onClick={isConnected ? handleEndWebRTCCall : handleStartWebRTCCall}
              className="w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-xl bg-[#3b82f6] hover:bg-[#2563eb]"
            >
              <Phone className="text-white" size={32} />
            </button>
            <span className="text-white text-xs mt-2 font-medium">On</span>
          </div>

          {/* Cancel ボタン */}
          <div className="flex flex-col items-center">
            <button
              onClick={handleEndWebRTCCall}
              className="w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-xl bg-red-500 hover:bg-red-600"
            >
              <PhoneOff className="text-white" size={24} />
            </button>
            <span className="text-white text-xs mt-2 font-medium">Cancel</span>
          </div>
        </div>

        {/* エラー表示（必要時） */}
        {state.error && (
          <div className="absolute top-6 right-6 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg z-20">
            <p className="text-sm">{state.error.message}</p>
          </div>
        )}

        {/* 紹介候補（Realtimeからの推薦） - オーバーレイ表示 */}
        {(state.recommendedIntroductions && state.recommendedIntroductions.length > 0) && (
          <div ref={recoSectionRef} className="absolute top-20 right-6 max-w-md z-10">
            <div className="bg-white rounded-xl shadow-xl p-4 space-y-4 max-h-[500px] overflow-y-auto">
              <h2 className="text-lg font-bold text-gray-900">紹介候補</h2>
              {state.recommendedIntroductions.map((rec: any, idx: number) => (
                <div key={idx} className="border-b border-gray-200 pb-3 last:border-b-0">
                  <img
                    src="/company_demo.jpg"
                    alt="紹介デモ"
                    className="w-full h-24 object-cover rounded mb-2"
                  />
                  <div className="text-xs text-gray-500">{rec.category} / {rec.subcategory}</div>
                  <div className="text-sm font-semibold text-gray-900 mt-1">{rec.company?.name}</div>
                  <div className="text-xs text-gray-700 mt-1">{rec.pitch}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
};
