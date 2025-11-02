import { RealtimeAPIClient } from '../RealtimeAPIClient';
import { RealtimeEvent } from '../../types/webrtc';
import {
  ConversationItemListener,
  RealtimeTransport,
  ResponseCreatePayload,
  SessionErrorListener,
} from './types';

type ConnectConfig = {
  consultantId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class RealtimeAPITransport implements RealtimeTransport {
  private conversationHandlers = new Map<
    ConversationItemListener,
    (payload: unknown) => void
  >();
  private errorHandlers = new Map<SessionErrorListener, (payload: unknown) => void>();

  constructor(private readonly client: RealtimeAPIClient) {}

  async connect(config?: ConnectConfig): Promise<void> {
    const consultantId = config?.consultantId;
    if (!consultantId) {
      throw new Error('consultantId is required to establish a realtime session');
    }
    await this.client.initializeSession(consultantId);
  }

  async disconnect(): Promise<void> {
    await this.client.endSession();
  }

  async sendResponseCreate(event: ResponseCreatePayload): Promise<void> {
    const realtimeEvent = event as unknown as RealtimeEvent;
    this.client.sendRealtimeEvent(realtimeEvent);
  }

  addEventListener(
    event: 'conversation.item' | 'error',
    listener: (payload: unknown) => void,
  ): () => void {
    if (event === 'conversation.item') {
      const handler = (payload: unknown) => {
        let itemPayload = payload;
        if (isRecord(payload) && 'item' in payload) {
          itemPayload = (payload as Record<string, unknown>).item;
        }
        listener(itemPayload);
      };

      this.client.on('conversationitemcreated', handler);
      this.conversationHandlers.set(listener as ConversationItemListener, handler);
      return () => {
        const stored = this.conversationHandlers.get(
          listener as ConversationItemListener,
        );
        if (stored) {
          this.client.off('conversationitemcreated', stored);
          this.conversationHandlers.delete(listener as ConversationItemListener);
        }
      };
    }

    if (event === 'error') {
      const handler = (payload: unknown) => listener(payload);
      this.client.on('realtimeapierror', handler);
      this.client.on('error', handler);
      this.errorHandlers.set(listener as SessionErrorListener, handler);
      return () => {
        const stored = this.errorHandlers.get(listener as SessionErrorListener);
        if (stored) {
          this.client.off('realtimeapierror', stored);
          this.client.off('error', stored);
          this.errorHandlers.delete(listener as SessionErrorListener);
        }
      };
    }

    throw new Error(`Unsupported event type: ${event}`);
  }
}
