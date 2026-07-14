export interface ChatSendAttempt {
  threadId: string;
  message: string;
  clientMessageId: string;
  attachmentIds: string[];
  model?: string;
}

export interface ChatSendExecution {
  threadId: string;
  generation: number;
}

export function isCurrentChatSendExecution(
  execution: ChatSendExecution,
  currentThreadId: string,
  currentGeneration: number,
): boolean {
  return execution.threadId === currentThreadId && execution.generation === currentGeneration;
}

export function createChatSendAttempt(
  input: { threadId: string; message: string; attachmentIds: string[]; model?: string | undefined },
  createId: () => string = () => crypto.randomUUID(),
): ChatSendAttempt {
  return {
    threadId: input.threadId,
    message: input.message,
    clientMessageId: createId(),
    attachmentIds: [...input.attachmentIds],
    ...(input.model ? { model: input.model } : {}),
  };
}

export function retryChatSendAttempt(attempt: ChatSendAttempt, currentThreadId: string): ChatSendAttempt | null {
  if (attempt.threadId !== currentThreadId) return null;
  return {
    threadId: attempt.threadId,
    message: attempt.message,
    clientMessageId: attempt.clientMessageId,
    attachmentIds: [...attempt.attachmentIds],
    ...(attempt.model ? { model: attempt.model } : {}),
  };
}
