import {
  ConversationItemEvent,
  ConversationItemListener,
  RealtimeApprovalRequest,
  RealtimeControllerOptions,
  RealtimeTransport,
  ResponseCreatePayload,
  SessionErrorListener,
} from './types';

const DEFAULT_PROMPT = '次のフェーズに移行していいですか？';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_AUDIO_FORMAT = 'wav';

export class RealtimeController {
  private readonly conversationListeners = new Set<ConversationItemListener>();
  private readonly errorListeners = new Set<SessionErrorListener>();
  private transportConversationUnsubscribe?: () => void;
  private transportErrorUnsubscribe?: () => void;

  constructor(
    private readonly transport: RealtimeTransport,
    private readonly options: RealtimeControllerOptions = {},
  ) {}

  async connect(config?: unknown): Promise<void> {
    await this.transport.connect(config);
    this.attachTransportListeners();
  }

  async cleanup(): Promise<void> {
    this.detachTransportListeners();
    this.conversationListeners.clear();
    this.errorListeners.clear();
    await this.transport.disconnect();
  }

  onConversationItem(listener: ConversationItemListener): () => void {
    this.conversationListeners.add(listener);
    return () => {
      this.conversationListeners.delete(listener);
    };
  }

  onSessionError(listener: SessionErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  async requestApproval(request: RealtimeApprovalRequest): Promise<void> {
    const instructions =
      request.prompt ??
      this.options.promptBuilder?.(request.phaseCandidate) ??
      DEFAULT_PROMPT;

    const modalities = ['audio'];
    if (request.includeText ?? this.options.includeTextModalities) {
      modalities.push('text');
    }

    const payload: ResponseCreatePayload = {
      type: 'response.create',
      response: {
        modalities,
        instructions,
        conversation: {
          importance: 'critical',
          metadata: {
            phase_candidate: request.phaseCandidate,
            request_id: request.transitionId,
            attempt: request.attempt,
            ...request.metadata,
          },
        },
        audio: {
          voice: request.voice ?? this.options.voice ?? DEFAULT_VOICE,
          format: DEFAULT_AUDIO_FORMAT,
        },
      },
    };

    if (modalities.includes('text')) {
      payload.response.text = { format: 'plain' };
    }

    await this.transport.sendResponseCreate(payload);
  }

  private attachTransportListeners(): void {
    if (!this.transportConversationUnsubscribe) {
      this.transportConversationUnsubscribe = this.transport.addEventListener(
        'conversation.item',
        this.handleConversationItem,
      );
    }

    if (!this.transportErrorUnsubscribe) {
      this.transportErrorUnsubscribe = this.transport.addEventListener(
        'error',
        this.handleErrorEvent,
      );
    }
  }

  private detachTransportListeners(): void {
    this.transportConversationUnsubscribe?.();
    this.transportConversationUnsubscribe = undefined;
    this.transportErrorUnsubscribe?.();
    this.transportErrorUnsubscribe = undefined;
  }

  private handleConversationItem = (payload: unknown): void => {
    const record = this.toRecord(payload);
    const event: ConversationItemEvent = {
      transcript: this.extractTranscript(record),
      confidence: this.extractConfidence(record),
      metadata: this.extractMetadata(record),
      raw: payload,
      role: this.extractRole(record),
    };

    this.conversationListeners.forEach((listener) => listener(event));
  };

  private handleErrorEvent = (payload: unknown): void => {
    this.errorListeners.forEach((listener) => listener(payload));
  };

  private extractTranscript(
    payload: Record<string, unknown> | null,
  ): string {
    if (!payload) return '';

    const transcript = payload['transcript'];
    if (typeof transcript === 'string') {
      return transcript;
    }

    const text = payload['text'];
    if (typeof text === 'string') {
      return text;
    }

    const content = payload['content'];
    if (Array.isArray(content)) {
      for (const part of content) {
        const partRecord = this.toRecord(part);
        if (!partRecord) continue;
        const partTranscript = partRecord['transcript'];
        if (typeof partTranscript === 'string') {
          return partTranscript;
        }
        const partText = partRecord['text'];
        if (typeof partText === 'string') {
          return partText;
        }
      }
    }

    return '';
  }

  private extractConfidence(
    payload: Record<string, unknown> | null,
  ): number | undefined {
    if (!payload) return undefined;

    const directConfidence = payload['confidence'];
    if (typeof directConfidence === 'number') {
      return directConfidence;
    }

    const metadata = this.extractMetadata(payload);
    if (metadata && typeof metadata['confidence'] === 'number') {
      return metadata['confidence'] as number;
    }

    return undefined;
  }

  private extractMetadata(
    payload: Record<string, unknown> | null,
  ): Record<string, unknown> | undefined {
    if (!payload) return undefined;
    const metadata = payload['metadata'];
    return isRecord(metadata) ? metadata : undefined;
  }

  private extractRole(payload: Record<string, unknown> | null): string | undefined {
    if (!payload) return undefined;
    const role = payload['role'];
    return typeof role === 'string' ? role : undefined;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
