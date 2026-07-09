import { z } from 'zod';

const UuidSchema = z.string().uuid();
const JsonRecordSchema = z.record(z.string(), z.unknown());

export const TraceSpanItemSchema = z
  .object({
    id: UuidSchema,
    traceId: z.string().min(1),
    parentSpanId: UuidSchema.nullable(),
    threadId: UuidSchema.nullable(),
    spanKind: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().int().nonnegative(),
    // Raw trace input/output can contain prompts, tool payloads, PII, or client
    // material. The public Trace Viewer contract deliberately exposes no raw
    // I/O preview; keep these nullable fields for wire compatibility only.
    inputPreview: z.null(),
    outputPreview: z.null(),
    metadata: JsonRecordSchema,
  })
  .strict();
export type TraceSpanItem = z.infer<typeof TraceSpanItemSchema>;

export const TraceSummarySchema = z
  .object({
    traceId: z.string().min(1),
    threadId: UuidSchema.nullable(),
    spanCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    startedAt: z.string().datetime({ offset: true }),
    lastAt: z.string().datetime({ offset: true }),
    totalDurationMs: z.number().int().nonnegative(),
    topSpanNames: z.array(z.string()).max(8),
  })
  .strict();
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

export const EvalCaseItemSchema = z
  .object({
    id: UuidSchema,
    threadId: UuidSchema.nullable(),
    caseKind: z.string().min(1),
    sourceRef: z.string().min(1),
    // Eval prompts can contain raw user/client data and must not be exposed in
    // the public Trace Viewer contract.
    promptPreview: z.null(),
    status: z.string().min(1),
    metadata: JsonRecordSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvalCaseItem = z.infer<typeof EvalCaseItemSchema>;

export const EvalRunItemSchema = z
  .object({
    id: UuidSchema,
    runKind: z.string().min(1),
    status: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    metrics: JsonRecordSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvalRunItem = z.infer<typeof EvalRunItemSchema>;

export const ObservabilityTraceListResponseSchema = z
  .object({
    traces: z.array(TraceSummarySchema),
    spans: z.array(TraceSpanItemSchema),
    evalCases: z.array(EvalCaseItemSchema),
    evalRuns: z.array(EvalRunItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ObservabilityTraceListResponse = z.infer<typeof ObservabilityTraceListResponseSchema>;
