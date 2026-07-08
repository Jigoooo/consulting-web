import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { ChatApprovalChoice, ChatMessageAttachment, ChatRuntimeModel } from '@consulting/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/useAuth';
import { useToast } from '../../../shared/ui/toast/Toast';
import { activeThreadStore, useTailScrollRequest } from '../../../lib/threadCtx';
import { useSelectedWorkspace } from '../../../lib/wsStore';
import { workspaceModalStore } from '../../../lib/workspaceModalStore';
import { useWorkspaceTree } from '../../../lib/spaces';
import {
  collabKeys,
  useDeleteAttachment,
  useUploadAttachment,
  fileToBase64,
} from '../../../lib/collab';
import { messageWindowKeys, useMessageWindow } from '../model/useMessageWindow';
import { findThreadLoadPreview, planInitialChannelLoad } from '../model/channelLoadPreview';
import { searchStore, useSearchState } from '../model/searchStore';
import { appendDraftAttachment, canSubmitDraft, createDraftAttachment, draftAttachmentsForSend } from '../model/draftAttachments';
import { RUNTIME_COMMANDS, describeRuntimeCommand, parseRuntimeCommand, resolveModelCommand, type RuntimeCommandItem } from '../model/runtimeCommands';
import { VirtualMessageStream, type HighlightState } from './VirtualMessageStream';
import { RunStatusBar, type RunStatusUi } from './RunStatusBar';
import { JumpToLatest } from './JumpToLatest';
import { ModelPickerSheet } from './ModelPickerSheet';
import { Icon } from '../../../shared/icons/Icon';
import { Button } from '../../../shared/ui/button/Button';
import { Textarea } from '../../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../../shared/ui/feedback/EmptyState';
import { SkeletonMessage } from '../../../shared/ui/skeleton/Skeleton';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { FileViewer, type FileViewerTarget } from '../../file-viewer/ui/FileViewer';
import s from '../../thread-view/ui/ThreadView.module.css';

interface LiveTurn {
  id: number;
  role: 'user' | 'ai';
  text: string;
  attachments?: ChatMessageAttachment[];
  runId?: string;
  streaming?: boolean;
  error?: string;
}

type RuntimeFlowMode = 'idle' | 'queueing' | 'steering' | 'answering' | 'approval' | 'stopping' | 'queued';

interface PendingApproval {
  runId: string;
  command?: string;
  message?: string;
  risk?: string;
  choices: ChatApprovalChoice[];
}

interface ThreadBreadcrumb {
  projectName: string;
  channelName: string;
  topicName: string;
}

const MODEL_STORAGE_KEY = 'consulting.chat.selected-model.v1';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function friendlyChatStreamError(message: string | undefined): string {
  const raw = message?.trim() ?? '';
  if (/Hermes run start failed \(401\)|invalid api key/iu.test(raw)) {
    return 'AI 실행 인증이 맞지 않아 답변을 시작하지 못했어요. 서버의 Hermes API 키를 갱신한 뒤 다시 시도해주세요.';
  }
  if (/Hermes run start failed \((?:5\d\d|502|503|504)\)/iu.test(raw)) {
    return 'AI 실행 서버가 일시적으로 응답하지 않아요. 잠시 후 다시 시도해주세요.';
  }
  if (/Hermes run start failed|Hermes proxy failed|Hermes run events failed/iu.test(raw)) {
    return 'AI 실행을 시작하지 못했어요. 잠시 후 다시 시도해주세요.';
  }
  return raw || '응답을 가져오지 못했어요. 다시 시도해주세요.';
}

function runtimeFlowCopy(mode: RuntimeFlowMode, activeTool: string | null): { label: string; detail: string } | null {
  if (mode === 'idle') return null;
  if (mode === 'queueing') return { label: 'Queueing', detail: 'Hermes run을 시작하는 중' };
  if (mode === 'steering') return { label: 'Steering', detail: activeTool ? `${activeTool} 실행 준비` : '모델이 방향을 잡는 중' };
  if (mode === 'answering') return { label: 'Answering', detail: '답변을 스트리밍하는 중' };
  if (mode === 'approval') return { label: 'Approval', detail: '실행 승인 대기 중' };
  if (mode === 'stopping') return { label: 'Stopping', detail: '상류 Hermes run 중단 요청 중' };
  return { label: 'Queued', detail: '현재 답변 뒤에 이어서 보낼 메시지 대기 중' };
}

function RuntimeFlowStrip({ mode, activeTool, queuedMessage }: { mode: RuntimeFlowMode; activeTool: string | null; queuedMessage: string | null }) {
  const copy = runtimeFlowCopy(mode, activeTool);
  if (!copy && !queuedMessage) return null;
  return (
    <div className={s.flowStrip} data-mode={mode}>
      <div className={s.flowMain}>
        <span className={s.flowDot} />
        <span className={s.flowLabel}>{copy?.label ?? 'Ready'}</span>
        <span className={s.flowDetail}>{copy?.detail ?? '입력 가능'}</span>
      </div>
      {queuedMessage ? <div className={s.flowQueued}>다음 메시지: {queuedMessage.slice(0, 80)}</div> : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  busyChoice,
  onResolve,
}: {
  approval: PendingApproval;
  busyChoice: ChatApprovalChoice | null;
  onResolve: (choice: ChatApprovalChoice) => void;
}) {
  const labels: Record<ChatApprovalChoice, string> = {
    once: '이번만 승인',
    session: '이 세션 승인',
    always: '항상 승인',
    deny: '거절',
  };
  return (
    <div className={s.approvalCard}>
      <div className={s.approvalHead}>
        <Icon name="warning" size="sm" decorative />
        <div>
          <strong>실행 승인이 필요합니다</strong>
          <span>Hermes가 호스트 작업을 계속하기 전에 확인을 기다립니다.</span>
        </div>
      </div>
      {approval.message ? <p>{approval.message}</p> : null}
      {approval.command ? <pre>{approval.command}</pre> : null}
      {approval.risk ? <div className={s.approvalRisk}>위험도: {approval.risk}</div> : null}
      <div className={s.approvalActions}>
        {approval.choices.map((choice) => (
          <Button
            key={choice}
            type="button"
            variant={choice === 'deny' ? 'outline' : 'primary'}
            size="sm"
            loading={busyChoice === choice}
            onClick={() => onResolve(choice)}
          >
            {labels[choice]}
          </Button>
        ))}
      </div>
    </div>
  );
}


/**
 * Live chat for a thread (persistent). History loads from the API; new sends
 * stream via SSE and are persisted server-side. Craft layer (U-2):
 * ThinkingRibbon fills the start→first-delta gap (now with REAL tool labels),
 * hover actions add copy/retry, hover on assistant messages glows the linked
 * evidence (E-4), and answers can be saved as artifacts (2-B) with file
 * attachments (2-D G-3).
 */
export function ChatThread({ threadId, topicId, title, breadcrumb, focusMessageId }: { threadId: string; topicId?: string | undefined; title: string; breadcrumb?: ThreadBreadcrumb; focusMessageId?: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const workspaceId = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(workspaceId ?? undefined);
  const history = useMessageWindow(threadId);
  const tailScrollRequest = useTailScrollRequest();
  const uploadAttachment = useUploadAttachment(threadId);
  const deleteAttachment = useDeleteAttachment(threadId);
  const [fileViewer, setFileViewer] = useState<FileViewerTarget | null>(null);
  const search = useSearchState();

  const [live, setLive] = useState<LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [slashCursor, setSlashCursor] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusUi | null>(null);
  const [busy, setBusy] = useState(false);
  const [runtimeFlow, setRuntimeFlow] = useState<RuntimeFlowMode>('idle');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const [draftFiles, setDraftFiles] = useState<ChatMessageAttachment[]>([]);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalBusyChoice, setApprovalBusyChoice] = useState<ChatApprovalChoice | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [runtimeModels, setRuntimeModels] = useState<ChatRuntimeModel[]>([]);
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState(false);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [selectedModel, setSelectedModel] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? '';
  });
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const queuedMessageRef = useRef<string | null>(null);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const lastPromptRef = useRef<string>('');
  const atBottomRef = useRef(true);
  const deltaBuf = useRef('');
  const rafId = useRef(0);
  const latestJumpRef = useRef<() => Promise<void>>(async () => {});
  const seenTailScrollRequest = useRef(tailScrollRequest);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // G9: paste/newline auto-grow. Height changes are batched in rAF so typing
  // does one layout read/write pair, capped at 10 readable rows.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      const style = window.getComputedStyle(el);
      const lineHeight = Number.parseFloat(style.lineHeight) || 24;
      const maxHeight = lineHeight * 10;
      el.style.height = 'auto';
      const nextHeight = Math.min(el.scrollHeight, maxHeight);
      el.style.height = `${nextHeight}px`;
      el.style.overflowY = el.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
    });
    return () => window.cancelAnimationFrame(id);
  }, [input]);

  // Register this thread as the active context (evidence panel target).
  useEffect(() => {
    activeThreadStore.set(threadId);
    return () => activeThreadStore.set(null);
  }, [threadId]);

  // A1: only follow new live output when the user is already at the tail.
  useEffect(() => {
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [live]);

  useEffect(() => {
    setLive([]);
    abortRef.current?.abort();
    setBusy(false);
    setRuntimeFlow('idle');
    setActiveTool(null);
    setQueuedMessage(null);
    setDraftFiles([]);
    queuedMessageRef.current = null;
    setPendingApproval(null);
    setApprovalBusyChoice(null);
    setSlashCursor(0);
    setSearchQuery('');
    setSearching(false);
    setTargetMessageId(null);
    setRunStatus(null);
    setUnseen(0);
    setAtBottom(true);
    atBottomRef.current = true;
    searchStore.reset(threadId);
  }, [threadId]);


  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (selectedModel) window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    else window.localStorage.removeItem(MODEL_STORAGE_KEY);
  }, [selectedModel]);

  async function loadRuntimeModels() {
    if (runtimeModelsLoading) return;
    setRuntimeModelsLoading(true);
    try {
      const res = await api.listRuntimeModels();
      setRuntimeModels(res.models.map((m) => ({ ...m, current: (selectedModel || res.defaultModel) === m.route })));
      setDefaultModel(res.defaultModel);
    } catch {
      toast('error', '모델 목록을 불러오지 못했어요.');
    } finally {
      setRuntimeModelsLoading(false);
    }
  }

  useEffect(() => {
    void loadRuntimeModels();
  }, []);

  useEffect(() => {
    if (busy || !queuedMessage) return;
    const next = queuedMessage;
    queuedMessageRef.current = null;
    setQueuedMessage(null);
    void send(next);
  }, [busy, queuedMessage]);

  function onAtBottomChange(next: boolean) {
    atBottomRef.current = next;
    setAtBottom(next);
    if (next) setUnseen(0);
  }

  // F3: when the focused search result changes (e.g. clicked in the right panel
  // or stepped via the navigator), jump the chat window to that message.
  const lastFocusedId = useRef<string | null>(null);
  // G6: prefer focusMessage — it scrolls in place when the hit is already loaded
  // (no window replacement → no layout shift) and only fetches an 'around' window
  // when the target is outside the loaded range.
  const focusMessageRef = useRef(history.focusMessage);
  focusMessageRef.current = history.focusMessage;
  useEffect(() => {
    if (search.threadId !== threadId) return;
    const hit = search.results[search.focusedIndex];
    if (!hit || hit.id === lastFocusedId.current) return;
    lastFocusedId.current = hit.id;
    void focusMessageRef.current(hit.id).then((target) => setTargetMessageId(target)).catch(() => {});
  }, [search.focusedIndex, search.results, search.threadId, threadId]);

  useEffect(() => {
    if (search.threadId !== threadId || !search.targetMessageId) return;
    lastFocusedId.current = search.targetMessageId;
    void focusMessageRef.current(search.targetMessageId).then((target) => setTargetMessageId(target)).catch(() => {});
  }, [search.targetMessageId, search.targetSeq, search.threadId, threadId]);

  // 자료실 evidence 딥링크(?m=<messageId>): 진입 시 그 답변 메시지로 정밀 점프.
  // focusMessage가 로드된 범위면 in-place 스크롤, 아니면 around 윈도우를 가져온다.
  const didDeepLinkFocus = useRef(false);
  useEffect(() => {
    if (!focusMessageId || didDeepLinkFocus.current) return;
    didDeepLinkFocus.current = true;
    void focusMessageRef.current(focusMessageId).then((target) => setTargetMessageId(target)).catch(() => {});
  }, [focusMessageId]);

  function patchTurn(id: number, patch: Partial<LiveTurn>) {
    setLive((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function openModelPicker() {
    setModelSheetOpen(true);
    if (runtimeModels.length === 0) void loadRuntimeModels();
  }

  async function refreshRunStatus(showToast = true) {
    const runId = runStatus?.runId;
    if (!runId) {
      if (showToast) toast('info', '아직 조회할 실행이 없어요.');
      return;
    }
    try {
      const status = await api.runStatus(runId, threadId);
      setRunStatus((prev) => ({
        ...(prev ?? { startedAt: Date.now(), state: 'running' as const }),
        runId: status.runId,
        ...(status.model ? { model: status.model } : {}),
        ...(status.usage ? { usage: status.usage } : {}),
        state: status.status === 'completed' ? 'done' : status.status === 'failed' || status.status === 'cancelled' ? 'error' : 'running',
        ...(status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled' ? { finishedAt: Date.now() } : {}),
      }));
      if (showToast) toast('info', `상태: ${status.status}${status.model ? ` · ${status.model}` : ''}`);
    } catch {
      if (showToast) toast('error', '실행 상태를 조회하지 못했어요.');
    }
  }

  async function stopCurrentRun() {
    const runId = runStatus?.runId;
    setRuntimeFlow('stopping');
    try {
      if (runId) await api.stopRun(runId, threadId);
      abortRef.current?.abort();
      toast('info', '중단 요청을 보냈어요.');
    } catch {
      abortRef.current?.abort();
      toast('error', '상류 중단 요청은 실패했지만 로컬 스트림은 끊었어요.');
    }
  }

  async function resolveApproval(choice: ChatApprovalChoice) {
    if (!pendingApproval) return;
    setApprovalBusyChoice(choice);
    try {
      await api.respondRunApproval(pendingApproval.runId, { threadId, choice });
      setPendingApproval(null);
      setRuntimeFlow('steering');
      toast(choice === 'deny' ? 'info' : 'success', choice === 'deny' ? '거절했습니다.' : '승인했습니다.');
    } catch {
      toast('error', '승인 응답 전송에 실패했어요.');
    } finally {
      setApprovalBusyChoice(null);
    }
  }

  function executeRuntimeCommand(raw: string): boolean {
    const parsed = parseRuntimeCommand(raw);
    if (!parsed) return false;
    if (parsed.command === '/model') {
      setInput('');
      const resolved = resolveModelCommand(raw, runtimeModels);
      if (resolved.action === 'select') {
        setSelectedModel(resolved.route);
        const label = runtimeModels.find((model) => model.route === resolved.route)?.label ?? resolved.route;
        toast('success', `모델 선택: ${label}`);
      } else {
        openModelPicker();
        if (resolved.query) toast('info', `일치하는 모델을 찾지 못했어요: ${resolved.query}`);
      }
      return true;
    }
    if (parsed.command === '/status' || parsed.command === '/usage') {
      setInput('');
      void refreshRunStatus(true);
      return true;
    }
    if (parsed.command === '/stop') {
      setInput('');
      if (busy) void stopCurrentRun();
      else toast('info', '진행 중인 실행이 없어요.');
      return true;
    }
    if (parsed.command === '/help' || parsed.command === '/commands') {
      setInput('');
      toast('info', parsed.command === '/help' ? describeRuntimeCommand(parsed.arg) : describeRuntimeCommand());
      return true;
    }
    return false;
  }

  function pickSlashItem(item: RuntimeCommandItem) {
    setInput(`${item.command}${item.args ? ' ' : ''}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function send(messageOverride?: string) {
    const message = (messageOverride ?? input).trim();
    const draftAttachments = draftAttachmentsForSend(draftFiles, messageOverride);
    if (!canSubmitDraft(message, draftAttachments)) return;
    if (!messageOverride && executeRuntimeCommand(message)) return;
    if (busy) {
      if (draftAttachments.length > 0) {
        toast('info', '파일 첨부 메시지는 현재 응답이 끝난 뒤 전송해주세요.');
        return;
      }
      queuedMessageRef.current = message;
      setQueuedMessage(message);
      setRuntimeFlow('queued');
      if (!messageOverride) setInput('');
      return;
    }
    if (!messageOverride) {
      setInput('');
      setDraftFiles([]);
    }
    lastPromptRef.current = message;
    setBusy(true);
    setRuntimeFlow('queueing');
    setRunStatus({ startedAt: Date.now(), state: 'running', ...(selectedModel ? { model: selectedModel } : {}) });
    setActiveTool(null);
    setPendingApproval(null);
    // sending pins us to the tail
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);

    const userTurn: LiveTurn = { id: nextId.current++, role: 'user', text: message, ...(draftAttachments.length > 0 ? { attachments: draftAttachments } : {}) };
    const aiTurn: LiveTurn = { id: nextId.current++, role: 'ai', text: '', streaming: true };
    setLive((prev) => [...prev, userTurn, aiTurn]);

    const controller = new AbortController();
    abortRef.current = controller;
    // A4: batch SSE deltas into one patch per animation frame instead of one
    // setState per token (was tens of re-renders/sec on the whole thread).
    let acc = '';
    const flush = () => {
      rafId.current = 0;
      if (!deltaBuf.current) return;
      acc += deltaBuf.current;
      deltaBuf.current = '';
      patchTurn(aiTurn.id, { text: acc });
    };
    const scheduleFlush = () => {
      if (!rafId.current) rafId.current = requestAnimationFrame(flush);
    };
    const cancelFlush = () => {
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }
      flush();
    };
    try {
      const attachmentIds = draftAttachments.map((file) => file.id);
      for await (const event of api.streamChat({
        threadId,
        message,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      }, controller.signal)) {
        if (event.type === 'start') {
          setRuntimeFlow('steering');
          patchTurn(aiTurn.id, { runId: event.runId });
          setRunStatus((prev) => {
            const next: RunStatusUi = {
              ...(prev ?? { startedAt: Date.now(), state: 'running' as const }),
              runId: event.runId,
              state: 'running',
            };
            if (event.model) next.model = event.model;
            if (event.contextLimit) next.contextLimit = event.contextLimit;
            return next;
          });
        } else if (event.type === 'tool') {
          // Phase 2-A: surface real tool activity in the ribbon.
          setRuntimeFlow('steering');
          setActiveTool(event.phase === 'started' ? event.tool : null);
        } else if (event.type === 'reasoning') {
          setRuntimeFlow('steering');
          setRunStatus((prev) => ({
            ...(prev ?? { startedAt: Date.now(), state: 'running' as const }),
            runId: event.runId,
            reasoning: true,
            reasoningText: event.text,
            state: 'running',
          }));
        } else if (event.type === 'delta') {
          setRuntimeFlow('answering');
          deltaBuf.current += event.text;
          setActiveTool(null);
          scheduleFlush();
        } else if (event.type === 'approval') {
          setRuntimeFlow('approval');
          setPendingApproval({
            runId: event.runId,
            choices: event.choices,
            ...(event.command ? { command: event.command } : {}),
            ...(event.message ? { message: event.message } : {}),
            ...(event.risk ? { risk: event.risk } : {}),
          });
        } else if (event.type === 'done') {
          cancelFlush();
          patchTurn(aiTurn.id, { streaming: false });
          setRunStatus((prev) => {
            const next: RunStatusUi = {
              ...(prev ?? { startedAt: Date.now(), state: 'done' as const }),
              runId: event.runId,
              finishedAt: Date.now(),
              state: 'done',
            };
            const usage = event.usage ?? prev?.usage;
            if (usage) next.usage = usage;
            return next;
          });
        } else if (event.type === 'error') {
          cancelFlush();
          setRuntimeFlow('idle');
          patchTurn(aiTurn.id, { streaming: false, error: friendlyChatStreamError(event.message) });
          setRunStatus((prev) => ({
            ...(prev ?? { startedAt: Date.now(), state: 'error' as const }),
            finishedAt: Date.now(),
            state: 'error',
          }));
          toast('error', '응답 생성 실패');
        }
      }
      cancelFlush();
      patchTurn(aiTurn.id, { streaming: false });
      setRunStatus((prev) => prev?.state === 'running' ? { ...prev, finishedAt: Date.now(), state: 'done' } : prev);
      setPendingApproval(null);
      setRuntimeFlow(queuedMessageRef.current ? 'queued' : 'idle');
      // A2: if the user scrolled away during the answer, surface an unseen count.
      if (!atBottomRef.current) setUnseen((n) => n + 1);
    } catch {
      cancelFlush();
      setRuntimeFlow(queuedMessageRef.current ? 'queued' : 'idle');
      if (controller.signal.aborted) {
        patchTurn(aiTurn.id, { streaming: false, error: '중단됨' });
      } else {
        patchTurn(aiTurn.id, { streaming: false, error: '응답을 가져오지 못했어요. 다시 시도해주세요.' });
        toast('error', '연결에 문제가 있어요. 잠시 후 다시 시도해주세요.');
      }
    } finally {
      setBusy(false);
      setActiveTool(null);
      abortRef.current = null;
      void qc.invalidateQueries({ queryKey: messageWindowKeys.latest(threadId), refetchType: 'none' });
      void qc.invalidateQueries({ queryKey: collabKeys.attachments(threadId) });
      // Evidence rows settle with the assistant message — refresh the panel.
      void qc.invalidateQueries({ queryKey: collabKeys.evidence(threadId) });
      void qc.invalidateQueries({ queryKey: collabKeys.evidenceDecision(threadId) });
      void qc.invalidateQueries({ queryKey: collabKeys.reviewQueue(threadId) });
    }
  }

  function cancel() {
    void stopCurrentRun();
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', '복사 완료');
    } catch {
      toast('error', '복사 실패');
    }
  }

  /** 2-B: save an assistant answer as a v1 artifact in the first project. */
  async function saveAsArtifact(content: string, messageId?: string) {
    const projectId = tree?.projects[0]?.id;
    if (!projectId) {
      toast('error', '산출물을 담을 프로젝트가 없어요. 먼저 프로젝트를 만들어주세요.');
      return;
    }
    const artifactTitle = window.prompt('산출물 제목을 입력하세요', `${title} — 지구 답변`);
    if (!artifactTitle?.trim()) return;
    try {
      const res = await api.createArtifact({
        projectId,
        title: artifactTitle.trim(),
        content,
        note: '채팅에서 저장',
        sourceThreadId: threadId,
        ...(messageId ? { sourceMessageId: messageId } : {}),
      });
      void qc.invalidateQueries({ queryKey: collabKeys.artifacts(workspaceId ?? '') });
      toast('success', '산출물 저장 완료');
      workspaceModalStore.open('artifacts', { projectId });
      void res;
    } catch {
      toast('error', '저장에 실패했어요. 편집 권한이 있는지 확인해주세요.');
    }
  }

  /** 2-D G-3: attach a file to this thread. */
  async function onPickFile(file: File | null) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast('error', '파일은 10MB 이하만 첨부할 수 있어요.');
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const uploaded = await uploadAttachment.mutateAsync({
        threadId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      });
      const draft = createDraftAttachment({
        id: uploaded.id,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        uploaderUserId: user?.id ?? null,
      });
      setDraftFiles((current) => appendDraftAttachment(current, draft));
      toast('success', `첨부 완료: ${file.name}`);
    } catch {
      toast('error', '첨부에 실패했어요. 이미지/PDF/텍스트만 지원해요.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeAttachment(attachment: ChatMessageAttachment) {
    if (deletingAttachmentId) return;
    setDeletingAttachmentId(attachment.id);
    try {
      await deleteAttachment.mutateAsync(attachment.id);
      setDraftFiles((current) => current.filter((item) => item.id !== attachment.id));
      setLive((current) => current.map((turn) => (
        turn.attachments
          ? { ...turn, attachments: turn.attachments.filter((item) => item.id !== attachment.id) }
          : turn
      )));
      if (fileViewer?.id === attachment.id) setFileViewer(null);
      void qc.invalidateQueries({ queryKey: messageWindowKeys.latest(threadId) });
      await history.resetToLatest();
      toast('success', `첨부 삭제: ${attachment.fileName}`);
    } catch {
      toast('error', '첨부 삭제에 실패했어요. 권한 또는 네트워크 상태를 확인해주세요.');
    } finally {
      setDeletingAttachmentId(null);
    }
  }

  async function searchTranscript() {
    const q = searchQuery.trim();
    if (!q) {
      searchStore.set({ query: '', results: [], files: [], evidence: [], focusedIndex: -1, targetMessageId: null, open: false });
      return;
    }
    setSearching(true);
    try {
      // F2: server does hangul-aware matching; ask for a generous result set so
      // the navigator + right-panel list are complete.
      const res = await api.searchMessages(threadId, { q, limit: 50 });
      // Setting focusedIndex to 0 triggers the focus effect → jumps to first hit.
      lastFocusedId.current = null;
      searchStore.set({
        threadId,
        query: q,
        results: res.results,
        files: res.files,
        evidence: res.evidence,
        focusedIndex: res.results.length > 0 ? 0 : -1,
        targetMessageId: null,
        open: true,
      });
    } catch {
      toast('error', '대화 검색에 실패했어요.');
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setSearchQuery('');
    setTargetMessageId(null);
    lastFocusedId.current = null;
    searchStore.reset(threadId);
  }

  function jumpToSearchHit(hit: { id: string }, index: number) {
    // Set focus index; the focusedIndex effect performs the actual jumpAround so
    // navigator / panel / this path all funnel through one code path (F3).
    searchStore.focusIndex(index);
    void hit;
  }

  // F3: result navigator — step to previous/next hit, wrapping around.
  function stepSearch(dir: 1 | -1) {
    const st = searchStore.get();
    if (st.results.length === 0) return;
    const nextIndex = st.focusedIndex + dir;
    const hit = st.results[((nextIndex % st.results.length) + st.results.length) % st.results.length];
    if (hit) void jumpToSearchHit(hit, nextIndex);
  }


  // A2 / G7-FAB: return to the live tail. From a search-jump ('around') window we
  // replace the window with the latest page in O(1) instead of paging down. A
  // re-entrancy guard makes rapid FAB taps a no-op while a jump is in flight, and
  // any active search state is cleared first so the tail isn't left highlighted.
  const jumpingToLatestRef = useRef(false);
  async function jumpToLatest() {
    if (jumpingToLatestRef.current) return;
    jumpingToLatestRef.current = true;
    try {
      // clear search first so the FAB always lands on the clean live tail
      if (search.query) {
        searchStore.reset(threadId);
        setSearchQuery('');
        setTargetMessageId(null);
      }
      if (history.mode === 'around' || history.hasNewer) {
        await history.resetToLatest();
      }
      atBottomRef.current = true;
      setAtBottom(true);
      setUnseen(0);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' }));
    } finally {
      jumpingToLatestRef.current = false;
    }
  }
  latestJumpRef.current = jumpToLatest;

  useEffect(() => {
    if (tailScrollRequest === seenTailScrollRequest.current) return;
    seenTailScrollRequest.current = tailScrollRequest;
    void latestJumpRef.current();
  }, [tailScrollRequest]);

  const userName = user?.displayName ?? '나';
  const persisted = history.messages;
  const threadLoadPreview = findThreadLoadPreview(tree, threadId, topicId);
  const initialHistoryPending = history.isLoading || (history.isFetchingLatest && persisted.length === 0);
  const knownEmptyThread = threadLoadPreview?.messageCount === 0;
  const historySkeletonReady = useDelayedFlag(initialHistoryPending, threadLoadPreview && threadLoadPreview.messageCount > 0 ? 0 : 300, 260);
  const initialLoadPlan = planInitialChannelLoad({
    isLoading: historySkeletonReady,
    cachedMessageCount: persisted.length,
    preview: threadLoadPreview,
    viewportHeight: streamRef.current?.clientHeight ?? 720,
  });
  const activeModelRoute = selectedModel || defaultModel || '';
  const activeModelLabel = runtimeModels.find((model) => model.route === activeModelRoute)?.label ?? (activeModelRoute || '모델 확인 중');

  const slashQuery = input.startsWith('/') && !input.includes('\n') ? input.slice(1).trim().toLocaleLowerCase() : '';
  const showSlashMenu = input.startsWith('/') && !input.includes('\n');
  // D1: defer the filter query so typing the command never janks the menu.
  const deferredSlashQuery = useDeferredValue(slashQuery);
  const slashItems = !showSlashMenu
    ? []
    : RUNTIME_COMMANDS.filter((item) => {
        if (!deferredSlashQuery) return true;
        return item.command.slice(1).includes(deferredSlashQuery) || item.title.toLocaleLowerCase().includes(deferredSlashQuery);
      }).slice(0, 7);

  useEffect(() => setSlashCursor(0), [slashQuery]);

  // F3: build the highlight set for the stream from the shared search state.
  const highlight: HighlightState | null = search.query && search.threadId === threadId
    ? {
        ids: new Set(search.results.map((r) => r.id)),
        query: search.query,
        focusedId: search.results[search.focusedIndex]?.id ?? null,
      }
    : null;

  // Channel transitions use known per-topic density from the workspace tree:
  // empty channels stay quiet, cached windows stay visible, and slow populated
  // channels get a correctly sized skeleton immediately instead of blank flicker.
  const showHistorySkeleton = initialLoadPlan.kind === 'skeleton';
  const showEmptyPrompt = persisted.length === 0 && live.length === 0 && !showHistorySkeleton && (!initialHistoryPending || knownEmptyThread);
  const hasResults = search.results.length > 0 && search.threadId === threadId;


  return (
    <>
      <div className={s.head}>
        <div className={s.headTitleBlock}>
          {breadcrumb ? (
            <>
              <div className={s.crumb}>{breadcrumb.projectName}</div>
              <div className={s.title}>{breadcrumb.channelName}</div>
              {breadcrumb.topicName &&
                breadcrumb.topicName !== '대화' &&
                breadcrumb.topicName !== breadcrumb.channelName && (
                  <div className={s.subTitle}>{breadcrumb.topicName}</div>
                )}
            </>
          ) : (
            <div className={s.title}>{title}</div>
          )}
        </div>
        <div className={s.right}>
          <div className={s.threadSearch}>
            <Icon name="search" size="xs" decorative />
            <input
              className={s.threadSearchInput}
              value={searchQuery}
              placeholder="대화·문서·근거 검색"
              onChange={(event) => {
                setSearchQuery(event.target.value);
                if (!event.target.value.trim()) {
                  searchStore.set({ query: '', results: [], files: [], evidence: [], focusedIndex: -1, targetMessageId: null, open: false });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (hasResults && search.query === searchQuery.trim()) {
                    // already searched → Enter steps to next hit (Ctrl+F feel)
                    stepSearch(event.shiftKey ? -1 : 1);
                  } else {
                    void searchTranscript();
                  }
                }
                if (event.key === 'Escape') {
                  if (searchQuery || search.query) clearSearch();
                  else event.currentTarget.blur();
                }
              }}
            />
            {searchQuery || search.query ? (
              <button type="button" className={`${s.threadSearchClear} cwTap`} aria-label="검색 취소" onClick={clearSearch}>
                <Icon name="x" size="xs" decorative />
              </button>
            ) : null}
            {hasResults ? (
              <div className={s.searchNav}>
                <button type="button" className={`${s.searchNavBtn} cwTap`} aria-label="이전 결과" onClick={() => stepSearch(-1)}>
                  <Icon name="chevron-left" size="xs" decorative />
                </button>
                <span className={s.searchNavCount}>
                  {search.focusedIndex + 1} / {search.results.length}
                </span>
                <button type="button" className={`${s.searchNavBtn} cwTap`} aria-label="다음 결과" onClick={() => stepSearch(1)}>
                  <Icon name="chevron-right" size="xs" decorative />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${s.threadSearchBtn} cwTap`}
                disabled={searching || history.isJumping}
                onClick={() => void searchTranscript()}
              >
                {searching ? '검색 중' : '검색'}
              </button>
            )}
            {/* G6: header result dropdown removed — the full result list lives in
                the right context panel's "검색" tab (auto-focused on search), so
                results appear in exactly one place. */}
          </div>
          {runStatus ? <RunStatusBar status={runStatus} /> : null}
          {busy || history.isJumping ? (
            <div className={s.statusChip}>
              <span className={s.pulse} /> {history.isJumping ? '위치 이동 중' : activeTool ? `${activeTool} 실행 중` : '응답 생성 중'}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className={s.stream} ref={streamRef} style={{ flex: 1 }}>
          {showHistorySkeleton && persisted.length === 0 && live.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {Array.from({ length: initialLoadPlan.skeletonRows }).map((_, i) => (
                <SkeletonMessage key={i} />
              ))}
            </div>
          ) : null}

          {showEmptyPrompt ? (
            <EmptyState icon="bot" title="지구에게 물어보세요" description="필요한 맥락을 짧게 남기면 바로 이어서 작업합니다." />
          ) : null}

          <VirtualMessageStream
            key={threadId}
            threadId={threadId}
            messages={persisted}
            live={live}
            userName={userName}
            busy={busy}
            activeTool={activeTool}
            scrollRef={streamRef}
            bottomRef={bottomRef}
            hasOlder={history.hasOlder}
            hasNewer={history.hasNewer}
            isLoadingOlder={history.isLoadingOlder}
            isLoadingNewer={history.isLoadingNewer}
            olderError={history.olderError}
            newerError={history.newerError}
            targetMessageId={targetMessageId}
            highlight={highlight}
            showNewDivider={!atBottom && unseen > 0}
            onLoadOlder={history.loadOlder}
            onLoadNewer={history.loadNewer}
            onAtBottomChange={onAtBottomChange}
            onCopy={copyText}
            onSaveArtifact={saveAsArtifact}
            onRetry={send}
            onRetryLast={() => send(lastPromptRef.current)}
            onChoice={(choice) => void send(choice)}
            onOpenAttachment={(attachment) => setFileViewer({ id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType })}
            onDeleteAttachment={removeAttachment}
            deletingAttachmentId={deletingAttachmentId}
          />
          <JumpToLatest
            visible={!atBottom || history.hasNewer || history.mode === 'around'}
            unseen={unseen}
            streaming={busy}
            onJump={() => void jumpToLatest()}
          />
        </div>
      </div>

      <div className={s.composer}>
        <RuntimeFlowStrip mode={runtimeFlow} activeTool={activeTool} queuedMessage={queuedMessage} />
        {pendingApproval ? (
          <ApprovalCard approval={pendingApproval} busyChoice={approvalBusyChoice} onResolve={(choice) => void resolveApproval(choice)} />
        ) : null}
        <div className={s.quickControls}>
          <Button variant="ghost" size="sm" type="button" leadingIcon="bot" onClick={openModelPicker}>
            모델 변경
          </Button>
          <span className={s.modelChip} title={activeModelRoute || undefined}>{activeModelLabel}</span>
          {runStatus?.runId ? (
            <Button variant="ghost" size="sm" type="button" leadingIcon="info" onClick={() => void refreshRunStatus(true)}>
              상태
            </Button>
          ) : null}
          {busy ? (
            <Button variant="outline" size="sm" type="button" leadingIcon="stop" onClick={() => void stopCurrentRun()}>
              중단
            </Button>
          ) : null}
        </div>
        {draftFiles.length > 0 ? (
          <div className={s.fileStrip}>
            {draftFiles.map((f) => (
              <div
                key={f.id}
                className={s.fileChip}
              >
                <button
                  type="button"
                  className={s.fileChipMain}
                  title={`미리보기 (${fmtSize(f.sizeBytes)})`}
                  onClick={() => setFileViewer({ id: f.id, fileName: f.fileName, mimeType: f.mimeType })}
                >
                  <Icon name="paperclip" size="xs" decorative /> {f.fileName} <span className={s.fileSize}>{fmtSize(f.sizeBytes)}</span>
                </button>
                <button
                  type="button"
                  className={s.fileChipRemove}
                  aria-label={`${f.fileName} 첨부 삭제`}
                  disabled={deletingAttachmentId === f.id}
                  onClick={() => void removeAttachment(f)}
                >
                  <Icon name="x" size="xs" decorative />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {showSlashMenu && slashItems.length > 0 ? (
          <div className={s.slashMenu} role="listbox" aria-label="Hermes slash commands">
            {slashItems.map((item, index) => (
              <button
                key={item.command}
                type="button"
                role="option"
                aria-selected={index === slashCursor}
                className={`${s.slashItem} ${index === slashCursor ? s.slashItemOn : ''}`}
                onMouseEnter={() => setSlashCursor(index)}
                onClick={() => pickSlashItem(item)}
              >
                <span className={s.slashCmd}>{item.command}</span>
                <span className={s.slashTitle}>{item.title}</span>
                <span className={s.slashHint}>{item.hint}</span>
              </button>
            ))}
            <div className={s.slashFoot}>↑↓ 선택 · Tab/Enter 채우기 · Enter 한 번 더 실행</div>
          </div>
        ) : null}
        <div className={s.box}>
          <div className={s.boxTop}>
            <Textarea
              ref={textareaRef}
              unstyled
              className={s.textarea}
              rows={1}
              value={input}
              placeholder="메시지를 입력하세요…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (showSlashMenu && slashItems.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSlashCursor((cursor) => Math.min(cursor + 1, slashItems.length - 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSlashCursor((cursor) => Math.max(cursor - 1, 0));
                    return;
                  }
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const item = slashItems[slashCursor];
                    if (item) pickSlashItem(item);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && slashItems[slashCursor]) {
                    e.preventDefault();
                    pickSlashItem(slashItems[slashCursor]);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className={s.bar}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf,.txt,.md,.csv"
              style={{ display: 'none' }}
              onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className={s.attachBtn}
              title="파일 첨부 (이미지/PDF/텍스트, 10MB 이하)"
              disabled={uploadAttachment.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {uploadAttachment.isPending ? <Spinner label="첨부 중" /> : <Icon name="paperclip" size="sm" decorative />}
            </button>
            <span className={s.hint}>Enter 전송 · Shift+Enter 줄바꿈 · ⌘K 이동</span>
            <div className={s.sendWrap}>
              {busy ? (
                <Button className={`${s.btn} ${s.btnGhost}`} variant="ghost" type="button" leadingIcon="stop" onClick={cancel}>
                  중단
                </Button>
              ) : null}
              <Button
                className={`${s.btn} ${s.btnPrimary}`}
                variant="primary"
                type="button"
                trailingIcon="send"
                disabled={busy || !canSubmitDraft(input, draftFiles)}
                onClick={() => void send()}
              >
                전송
              </Button>
            </div>
          </div>
        </div>
      </div>
      {fileViewer ? <FileViewer target={fileViewer} onClose={() => setFileViewer(null)} /> : null}
      <ModelPickerSheet
        open={modelSheetOpen}
        onOpenChange={setModelSheetOpen}
        models={runtimeModels}
        selectedModel={selectedModel}
        defaultModel={defaultModel}
        loading={runtimeModelsLoading}
        onSelect={setSelectedModel}
      />
    </>
  );
}
