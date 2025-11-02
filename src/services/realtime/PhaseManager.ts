import { RealtimeController } from './RealtimeController';
import {
  ConversationItemEvent,
  ConsultingPhase,
  PhaseManagerOptions,
  PhaseTransitionState,
  RealtimeApprovalDecision,
} from './types';

const YES_TOKENS = ['はい', 'うん', 'ok', '承認', 'お願いします', '了解'];
const NO_TOKENS = ['いいえ', 'いや', 'ノー', '保留', 'まだ', '待って'];
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export class PhaseManager {
  private currentPhase: ConsultingPhase;
  private pending: PhaseTransitionState | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly conversationUnsubscribe: () => void;
  private readonly errorUnsubscribe: () => void;

  constructor(
    private readonly controller: RealtimeController,
    private readonly options: PhaseManagerOptions = {},
  ) {
    this.currentPhase = options.initialPhase ?? 'deep_research';
    this.conversationUnsubscribe = this.controller.onConversationItem(
      this.handleConversationItem,
    );
    this.errorUnsubscribe = this.controller.onSessionError(
      this.handleSessionError,
    );
  }

  getPhase(): ConsultingPhase {
    return this.currentPhase;
  }

  getPendingTransition(): PhaseTransitionState | null {
    return this.pending;
  }

  requestTransition(nextPhase: ConsultingPhase): void {
    if (this.pending && this.pending.phaseCandidate === nextPhase) {
      return;
    }

    this.clearPendingTransition();

    const transitionId = this.generateTransitionId();
    this.pending = {
      id: transitionId,
      phaseCandidate: nextPhase,
      attempt: 0,
      maxAttempts:
        this.options.maxApprovalAttempts ?? DEFAULT_MAX_ATTEMPTS,
      timeoutMs: this.options.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      expiresAt: Date.now(),
    };

    this.options.onTransitionRequested?.({
      phaseCandidate: nextPhase,
      transitionId,
      attempt: 0,
    });

    this.dispatchApprovalRequest();
  }

  forceTransition(nextPhase: ConsultingPhase): void {
    const previous = this.currentPhase;
    this.currentPhase = nextPhase;
    this.clearPendingTransition();
    this.options.onPhaseChanged?.({
      previous,
      current: nextPhase,
      transitionId: 'forced',
      metadata: { forced: true },
    });
  }

  dispose(): void {
    this.clearPendingTransition();
    this.conversationUnsubscribe();
    this.errorUnsubscribe();
  }

  private dispatchApprovalRequest(): void {
    if (!this.pending) return;

    if (this.pending.attempt >= this.pending.maxAttempts) {
      this.handleDeclined('max_attempts');
      return;
    }

    this.pending.attempt += 1;
    this.pending.expiresAt = Date.now() + this.pending.timeoutMs;

    this.options.onTransitionRequested?.({
      phaseCandidate: this.pending.phaseCandidate,
      transitionId: this.pending.id,
      attempt: this.pending.attempt,
    });

    this.controller
      .requestApproval({
        phaseCandidate: this.pending.phaseCandidate,
        transitionId: this.pending.id,
        attempt: this.pending.attempt,
        prompt: this.options.promptBuilder?.(this.pending.phaseCandidate),
        voice: this.options.voice,
        includeText: this.options.includeTextModalities ?? true,
        metadata: {
          pending_attempt: this.pending.attempt,
        },
      })
      .catch((error) => {
        this.handleErrorEvent('transport_error', error);
      });

    this.scheduleTimeout();
  }

  private handleConversationItem = (event: ConversationItemEvent): void => {
    if (!this.pending) return;
    if (event.role && event.role !== 'user') return;

    const requestId =
      typeof event.metadata?.request_id === 'string'
        ? (event.metadata.request_id as string)
        : undefined;

    if (requestId && requestId !== this.pending.id) {
      return;
    }

    const decision = resolveApproval(
      event.transcript,
      event.confidence ?? 1,
    );

    if (decision === 'retry') {
      if (this.pending.attempt >= this.pending.maxAttempts) {
        this.handleDeclined('max_attempts');
      } else {
        this.dispatchApprovalRequest();
      }
      return;
    }

    if (decision === 'approved') {
      this.handleApproved();
    } else {
      this.handleDeclined('user_declined');
    }
  };

  private handleErrorEvent(reason: string, error: unknown): void {
    if (!this.pending) {
      return;
    }

    this.options.onTransitionError?.({
      phaseCandidate: this.pending.phaseCandidate,
      transitionId: this.pending.id,
      error,
    });

    this.handleDeclined(reason);
  }

  private handleSessionError = (error: unknown): void => {
    this.handleErrorEvent('session_error', error);
  };

  private handleTimeout = (): void => {
    if (!this.pending) return;

    if (Date.now() >= this.pending.expiresAt) {
      if (this.pending.attempt >= this.pending.maxAttempts) {
        this.handleDeclined('timeout');
      } else {
        this.dispatchApprovalRequest();
      }
    } else {
      this.scheduleTimeout();
    }
  };

  private scheduleTimeout(): void {
    if (!this.pending) return;
    this.clearTimeoutHandle();
    this.timeoutHandle = setTimeout(
      this.handleTimeout,
      this.pending.timeoutMs,
    );
  }

  private handleApproved(): void {
    if (!this.pending) return;
    const previous = this.currentPhase;
    this.currentPhase = this.pending.phaseCandidate;

    const transitionId = this.pending.id;
    this.clearPendingTransition();

    this.options.onPhaseChanged?.({
      previous,
      current: this.currentPhase,
      transitionId,
    });
  }

  private handleDeclined(reason: string): void {
    if (!this.pending) return;
    const { phaseCandidate, id } = this.pending;
    this.clearPendingTransition();
    this.options.onTransitionDeclined?.({
      phaseCandidate,
      transitionId: id,
      reason,
    });
  }

  private clearPendingTransition(): void {
    this.clearTimeoutHandle();
    this.pending = null;
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private generateTransitionId(): string {
    return `phase_${Date.now().toString(36)}_${Math.random()
      .toString(16)
      .slice(2, 10)}`;
  }
}

export function resolveApproval(
  transcript: string,
  confidence: number,
): RealtimeApprovalDecision {
  if (!transcript) return 'retry';
  if (confidence < 0.6) return 'retry';

  const normalized = transcript.trim().toLowerCase();

  if (YES_TOKENS.some((token) => normalized.includes(token))) {
    return 'approved';
  }

  if (NO_TOKENS.some((token) => normalized.includes(token))) {
    return 'declined';
  }

  return 'retry';
}
