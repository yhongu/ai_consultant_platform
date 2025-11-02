import React, { useState } from 'react';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Volume2,
  VolumeX,
  Settings,
  Wifi,
  WifiOff,
  AlertCircle,
  Activity,
} from 'lucide-react';

interface RealtimeVoiceControlsProps {
  // 接続状態
  isConnected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
  
  // 音声状態
  isMuted: boolean;
  isRemoteMuted: boolean;
  audioLevel: number;
  isVoiceActive: boolean;
  
  // 会話フェーズ
  conversationPhase: 'questions' | 'hot-reading' | 'cold-reading' | 'subsidies' | 'summary' | 'recommendations';
  
  // エラー情報
  error?: {
    type: string;
    message: string;
    suggestions?: string[];
  };
  
  // フォールバック状態
  isFallbackMode: boolean;
  
  // イベントハンドラー
  onStartCall: () => void;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleRemoteMute: () => void;
  onVolumeChange: (volume: number) => void;
  onRetryConnection?: () => void;
  onSwitchToFallback?: () => void;
}

export const RealtimeVoiceControls: React.FC<RealtimeVoiceControlsProps> = ({
  isConnected,
  connectionState,
  isMuted,
  isRemoteMuted,
  audioLevel,
  isVoiceActive,
  conversationPhase,
  error,
  isFallbackMode,
  onStartCall,
  onEndCall,
  onToggleMute,
  onToggleRemoteMute,
  onVolumeChange,
  onRetryConnection,
  onSwitchToFallback
}) => {
  const [volume, setVolume] = useState(80);
  const [showSettings, setShowSettings] = useState(false);

  // 音量変更のハンドラー
  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    onVolumeChange(newVolume / 100);
  };

  // 接続状態のスタイル
  const getConnectionStatusStyle = () => {
    switch (connectionState) {
      case 'connected':
        return 'bg-green-500 text-white';
      case 'connecting':
        return 'bg-yellow-500 text-white animate-pulse';
      case 'error':
        return 'bg-red-500 text-white';
      default:
        return 'bg-gray-500 text-white';
    }
  };

  const getPhaseDisplayName = (
    phase:
      | 'questions'
      | 'hot-reading'
      | 'cold-reading'
      | 'subsidies'
      | 'summary'
      | 'recommendations',
  ): string => {
    switch (phase) {
      case 'questions':
        return '質問';
      case 'hot-reading':
        return 'ホットリーディング';
      case 'cold-reading':
        return 'コールドリーディング';
      case 'subsidies':
        return '補助金提案';
      case 'summary':
        return 'サマリー';
      case 'recommendations':
        return '推奨事項';
      default:
        return '不明';
    }
  };

  // 音声レベルのビジュアライザー
  const VoiceLevelIndicator = () => (
    <div className="flex items-center space-x-1">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className={`w-1 h-4 rounded transition-all duration-200 ${
            (audioLevel / 20) > i 
              ? isVoiceActive 
                ? 'bg-green-500' 
                : 'bg-blue-500'
              : 'bg-gray-300'
          }`}
        />
      ))}
    </div>
  );

  return (
    <div className="bg-white rounded-lg shadow-lg border p-6 space-y-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">音声通話</h3>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <Settings className="w-5 h-5 text-gray-600" />
        </button>
      </div>

      {/* 接続状態表示 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          {isConnected ? (
            <Wifi className="w-5 h-5 text-green-500" />
          ) : (
            <WifiOff className="w-5 h-5 text-gray-400" />
          )}
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${getConnectionStatusStyle()}`}>
            {connectionState === 'disconnected' && '未接続'}
            {connectionState === 'connecting' && '接続中...'}
            {connectionState === 'connected' && '接続済み'}
            {connectionState === 'error' && 'エラー'}
          </span>
        </div>
        
        {/* フォールバックモード表示 */}
        {isFallbackMode && (
          <span className="px-3 py-1 bg-orange-100 text-orange-800 rounded-full text-sm font-medium">
            フォールバックモード
          </span>
        )}
      </div>

      {isConnected && (
        <div className="bg-blue-50 p-3 rounded-lg">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-medium text-blue-800">
              現在のフェーズ: {getPhaseDisplayName(conversationPhase)}
            </span>
          </div>
        </div>
      )}

      {/* メイン操作ボタン */}
      <div className="flex items-center justify-center space-x-4">
        {!isConnected ? (
          <button
            onClick={onStartCall}
            disabled={connectionState === 'connecting'}
            className="flex items-center space-x-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            <Phone className="w-5 h-5" />
            <span>{connectionState === 'connecting' ? '接続中...' : '通話開始'}</span>
          </button>
        ) : (
          <button
            onClick={onEndCall}
            className="flex items-center space-x-2 bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            <PhoneOff className="w-5 h-5" />
            <span>通話終了</span>
          </button>
        )}
      </div>

      {/* 音声コントロール（接続後に表示） */}
      {isConnected && (
        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-2">
            <button
              onClick={onToggleMute}
              className={`w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-lg font-medium transition-colors ${
                isMuted
                  ? 'bg-red-100 text-red-700 hover:bg-red-200'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              <span>{isMuted ? 'ミュート中' : 'マイク'}</span>
            </button>

            <div className="flex items-center space-x-2">
              <span className="text-xs text-gray-600">入力:</span>
              <VoiceLevelIndicator />
            </div>
          </div>

          {/* リモート音声／音量は必要になったら再度有効化 */}
          {false && (
            <div className="space-y-2">
              <button
                onClick={onToggleRemoteMute}
                className={`w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-lg font-medium transition-colors ${
                  isRemoteMuted
                    ? 'bg-red-100 text-red-700 hover:bg-red-200'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {isRemoteMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                <span>{isRemoteMuted ? '音声OFF' : 'スピーカー'}</span>
              </button>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">音量:</span>
                  <span className="text-xs text-gray-600">{volume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start space-x-2">
            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-red-800">{error.message}</h4>
              {error.suggestions && error.suggestions.length > 0 && (
                <ul className="mt-2 text-sm text-red-700 space-y-1">
                  {error.suggestions.map((suggestion, index) => (
                    <li key={index} className="flex items-start space-x-1">
                      <span>•</span>
                      <span>{suggestion}</span>
                    </li>
                  ))}
                </ul>
              )}
              
              {/* エラー時の操作ボタン */}
              <div className="mt-3 flex space-x-2">
                {onRetryConnection && (
                  <button
                    onClick={onRetryConnection}
                    className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors"
                  >
                    再接続
                  </button>
                )}
                {onSwitchToFallback && !isFallbackMode && (
                  <button
                    onClick={onSwitchToFallback}
                    className="px-3 py-1 bg-orange-600 text-white text-sm rounded hover:bg-orange-700 transition-colors"
                  >
                    フォールバック
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 詳細設定 */}
      {showSettings && (
        <div className="bg-gray-50 rounded-lg p-4 space-y-3">
          <h4 className="text-sm font-medium text-gray-900">詳細設定</h4>
          
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600">接続品質:</span>
              <span className="ml-2 font-medium">
                {isConnected ? '良好' : '未接続'}
              </span>
            </div>
            <div>
              <span className="text-gray-600">音声モード:</span>
              <span className="ml-2 font-medium">
                {isFallbackMode ? 'フォールバック' : 'リアルタイム'}
              </span>
            </div>
            <div>
              <span className="text-gray-600">マイク状態:</span>
              <span className="ml-2 font-medium">
                {isMuted ? 'ミュート' : '有効'}
              </span>
            </div>
            <div>
              <span className="text-gray-600">音声検出:</span>
              <span className="ml-2 font-medium">
                {isVoiceActive ? '音声あり' : '無音'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* CSS for slider styling */}
      <style>{`
        .slider::-webkit-slider-thumb {
          appearance: none;
          width: 16px;
          height: 16px;
          background: #3B82F6;
          border-radius: 50%;
          cursor: pointer;
        }
        
        .slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          background: #3B82F6;
          border-radius: 50%;
          cursor: pointer;
          border: none;
        }
      `}</style>
    </div>
  );
};
