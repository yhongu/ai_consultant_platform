export type ConsultingPhase =
  | 'deep_research'
  | 'mode_check'
  | 'consulting'
  | 'summary';

export type RealtimeApprovalDecision = 'approved' | 'declined' | 'retry';

export interface ConversationItemEvent {
  transcript: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  raw?: unknown;
  role?: string;
}

export type ConversationItemListener = (event: ConversationItemEvent) => void;

export type SessionErrorListener = (error: unknown) => void;

export interface ResponseCreatePayload {
  type: 'response.create';
  response: {
    modalities: string[];
    instructions: string;
    conversation?: {
      importance?: 'critical' | 'normal';
      metadata?: Record<string, unknown>;
    };
    audio?: {
      voice?: string;
      format?: string;
    };
    text?: {
      format?: string;
    };
  };
}

export interface RealtimeApprovalRequest {
  phaseCandidate: ConsultingPhase;
  transitionId: string;
  attempt: number;
  prompt?: string;
  voice?: string;
  includeText?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RealtimeControllerOptions {
  voice?: string;
  promptBuilder?: (phase: ConsultingPhase) => string;
  includeTextModalities?: boolean;
}

export interface RealtimeTransport {
  connect(config?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  sendResponseCreate(event: ResponseCreatePayload): Promise<void>;
  addEventListener(
    event: 'conversation.item' | 'error',
    listener: (payload: unknown) => void,
  ): () => void;
}

export interface PhaseTransitionState {
  id: string;
  phaseCandidate: ConsultingPhase;
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  expiresAt: number;
}

export interface PhaseManagerCallbacks {
  onPhaseChanged?: (info: {
    previous: ConsultingPhase;
    current: ConsultingPhase;
    transitionId: string;
    metadata?: Record<string, unknown>;
  }) => void;
  onTransitionDeclined?: (info: {
    phaseCandidate: ConsultingPhase;
    transitionId: string;
    reason: string;
  }) => void;
  onTransitionError?: (info: {
    phaseCandidate: ConsultingPhase;
    transitionId: string;
    error: unknown;
  }) => void;
  onTransitionRequested?: (info: {
    phaseCandidate: ConsultingPhase;
    transitionId: string;
    attempt: number;
  }) => void;
}

export interface PhaseManagerOptions extends PhaseManagerCallbacks {
  initialPhase?: ConsultingPhase;
  maxApprovalAttempts?: number;
  approvalTimeoutMs?: number;
  promptBuilder?: (phase: ConsultingPhase) => string;
  voice?: string;
  includeTextModalities?: boolean;
}
