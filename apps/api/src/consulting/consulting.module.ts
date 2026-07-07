import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { ConsultingGraphRagBridge } from './consulting-graphrag-bridge.service.js';
import { ConsultingMemoryContextBuilder } from './consulting-memory-context.builder.js';
import { CitationPostCheckService } from './citation-post-check.service.js';
import { EvidenceSufficiencyEvaluator } from './evidence-sufficiency-evaluator.service.js';
import { ConsultingWebIngestService } from './consulting-web-ingest.service.js';
import {
  CONSULTING_WEB_INGEST_RUNNER,
  ConsultingWebIngestWorker,
  defaultConsultingWebIngestRunner,
} from './consulting-web-ingest.worker.js';
import { ConsultingTopicResolver } from './consulting-topic-resolver.service.js';

@Module({
  imports: [DrizzleModule],
  providers: [
    ConsultingTopicResolver,
    ConsultingGraphRagBridge,
    CitationPostCheckService,
    EvidenceSufficiencyEvaluator,
    ConsultingMemoryContextBuilder,
    ConsultingWebIngestService,
    { provide: CONSULTING_WEB_INGEST_RUNNER, useValue: defaultConsultingWebIngestRunner },
    ConsultingWebIngestWorker,
  ],
  exports: [ConsultingTopicResolver, ConsultingGraphRagBridge, CitationPostCheckService, EvidenceSufficiencyEvaluator, ConsultingMemoryContextBuilder, ConsultingWebIngestService],
})
export class ConsultingModule {}
