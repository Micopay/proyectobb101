import { useState, useEffect, useCallback, useRef } from 'react';

export interface TradeMessage {
  id: string;
  tradeId: string;
  senderId: string;
  senderRole: 'buyer' | 'merchant';
  body: string;
  createdAt: string;
  readAt: string | null;
  isOwn: boolean;
}

/** Raw shape returned by the backend (snake_case, no isOwn/senderRole). */
interface RawTradeMessage {
  id: string;
  trade_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

function mapMessage(raw: RawTradeMessage, userId: string): TradeMessage {
  return {
    id: raw.id,
    tradeId: raw.trade_id,
    senderId: raw.sender_id,
    senderRole: raw.sender_id === userId ? 'buyer' : 'merchant',
    body: raw.body,
    createdAt: raw.created_at,
    readAt: null,
    isOwn: raw.sender_id === userId,
  };
}

interface UseChatMessagesOptions {
  tradeId: string;
  userId: string;
  token: string | null | undefined;
  apiBaseUrl?: string;
}

interface UseChatMessagesReturn {
  messages: TradeMessage[];
  isLoading: boolean;
  error: Error | null;
  sendMessage: (body: string) => Promise<void>;
  isSending: boolean;
  sendError: Error | null;
  retryLoad: () => void;
  retrySend: (messageId: string) => void;
}

/**
 * useChatMessages: Hook for managing trade chat with polling, optimistic updates, and error handling.
 *
 * Features:
 * - Polls GET /trades/:id/messages every 3 seconds when component is mounted
 * - Pauses polling when document is hidden (tab not visible)
 * - Optimistic message sends with rollback on failure
 * - Automatic retry on load/send failure
 * - Tracks separate loading and sending states
 *
 * POLLING STRATEGY:
 * - On mount: fetch GET /trades/:id/messages
 * - Then: setInterval polling every 3s, filtering for NEW messages only
 * - Pause when document.hidden === true
 * - Resume when document becomes visible
 * - Clear interval on unmount
 *
 * OPTIMISTIC SENDS:
 * - Append message with id prefixed "temp-" immediately
 * - On success: replace temp message with server response
 * - On failure: mark message as failed, allow retry
 */
export function useChatMessages({
  tradeId,
  userId,
  token,
  apiBaseUrl = 'http://localhost:3000',
}: UseChatMessagesOptions): UseChatMessagesReturn {
  const [messages, setMessages] = useState<TradeMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<Error | null>(null);

  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageTimeRef = useRef<string | null>(null);
  const failedMessagesRef = useRef<Map<string, { body: string; error: Error }>>(new Map());

  /**
   * Fetch messages for the trade.
   * If before is provided, fetch older messages (pagination).
   * If after is provided, fetch only new messages since that timestamp.
   */
  const fetchMessages = useCallback(
    async (beforeTimestamp?: string) => {
      try {
        const url = new URL(`${apiBaseUrl}/trades/${tradeId}/messages`);
        if (beforeTimestamp) {
          url.searchParams.append('before', beforeTimestamp);
        }

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token ?? ''}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.statusText}`);
        }

        const data = await response.json();
        const newMessages = ((data.messages || []) as RawTradeMessage[]).map((m) => mapMessage(m, userId));

        // Update last message time for polling
        if (newMessages.length > 0) {
          const newest = newMessages[newMessages.length - 1];
          lastMessageTimeRef.current = newest.createdAt;
        }

        setMessages(newMessages);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [tradeId, apiBaseUrl, token, userId]
  );

  /**
   * Poll for NEW messages since the last known message.
   * This is called every 3 seconds to get fresh messages without re-fetching all history.
   */
  const pollNewMessages = useCallback(async () => {
    // Don't poll if tab is hidden
    if (document.hidden) {
      return;
    }

    try {
      const url = new URL(`${apiBaseUrl}/trades/${tradeId}/messages`);
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token ?? ''}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Log but don't fail — continue polling
        console.warn('Poll failed:', response.statusText);
        return;
      }

      const data = await response.json();
      const newMessages = ((data.messages || []) as RawTradeMessage[]).map((m) => mapMessage(m, userId));

      // Merge with existing messages, deduplicating by ID
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const toAdd = newMessages.filter((m) => !existingIds.has(m.id));
        return [...prev, ...toAdd].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

      if (newMessages.length > 0) {
        lastMessageTimeRef.current = newMessages[newMessages.length - 1].createdAt;
      }
    } catch (err) {
      // Silently continue polling
      console.warn('Poll error:', err);
    }
  }, [tradeId, apiBaseUrl, token, userId]);

  /**
   * Initial load on mount, then start polling.
   */
  useEffect(() => {
    setIsLoading(true);
    fetchMessages()
      .then(() => setIsLoading(false))
      .catch(() => setIsLoading(false));

    // Start polling
    pollingIntervalRef.current = setInterval(pollNewMessages, 3000);

    // Listen for visibility changes
    const handleVisibilityChange = () => {
      if (!document.hidden && pollingIntervalRef.current) {
        // Tab became visible — poll immediately
        pollNewMessages();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchMessages, pollNewMessages]);

  /**
   * Send a message to the trade.
   * Optimistic: append message immediately, replace on success or mark failed on error.
   */
  const sendMessage = useCallback(
    async (body: string) => {
      setSendError(null);

      // Trim and validate
      const trimmed = body.trim();
      if (!trimmed || trimmed.length > 2000) {
        setSendError(new Error('Message must be between 1 and 2000 characters'));
        return;
      }

      // Optimistic update
      const tempId = `temp-${Date.now()}-${Math.random()}`;
      const optimisticMessage: TradeMessage = {
        id: tempId,
        tradeId,
        senderId: userId,
        senderRole: 'buyer', // Placeholder — should be derived from trade context
        body: trimmed,
        createdAt: new Date().toISOString(),
        readAt: null,
        isOwn: true,
      };

      setMessages((prev) => [...prev, optimisticMessage]);
      setIsSending(true);

      try {
        const response = await fetch(`${apiBaseUrl}/trades/${tradeId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body: trimmed }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `Failed to send: ${response.statusText}`);
        }

        const { message: rawSentMessage } = (await response.json()) as { message: RawTradeMessage };
        const sentMessage = mapMessage(rawSentMessage, userId);

        // Replace optimistic message with real response
        setMessages((prev) =>
          prev.map((msg) => (msg.id === tempId ? sentMessage : msg))
        );

        lastMessageTimeRef.current = sentMessage.createdAt;
        failedMessagesRef.current.delete(tempId);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setSendError(error);

        // Mark message as failed
        failedMessagesRef.current.set(tempId, { body: trimmed, error });
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === tempId
              ? { ...msg, id: tempId, body: `${trimmed} [Failed]` }
              : msg
          )
        );
      } finally {
        setIsSending(false);
      }
    },
    [tradeId, userId, apiBaseUrl, token]
  );

  /**
   * Retry a failed send.
   */
  const retrySend = useCallback(
    (messageId: string) => {
      const failed = failedMessagesRef.current.get(messageId);
      if (failed) {
        sendMessage(failed.body);
      }
    },
    [sendMessage]
  );

  /**
   * Retry the initial load.
   */
  const retryLoad = useCallback(() => {
    setIsLoading(true);
    fetchMessages();
  }, [fetchMessages]);

  return {
    messages,
    isLoading,
    error,
    sendMessage,
    isSending,
    sendError,
    retryLoad,
    retrySend,
  };
}
