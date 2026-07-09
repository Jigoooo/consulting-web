import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { ConsultingGraphRagBridge } from './consulting-graphrag-bridge.service.js';
import { ConsultingMemoryContextBuilder } from './consulting-memory-context.builder.js';
import { CitationPostCheckService } from './citation-post-check.service.js';
import { EvidenceSufficiencyEvaluator } from './evidence-sufficiency-evaluator.service.js';
import { EvidenceDecisionStore } from './evidence-decision.store.js';
import { EvidenceToDecisionService } from './evidence-to-decision.service.js';
import { ExactnessGateService } from './exactness-gate.service.js';
import { VerifierGatePolicyService } from './verifier-gate-policy.service.js';
import { ConsultingJudgmentGuardService } from './consulting-judgment-guard.service.js';
import { ClaimVerifierService, DisabledLlmStrictJsonVerifier, HermesStrictJsonVerifier, LocalNliProvider } from './claim-verifier.service.js';
import { DocumentUnitEmbeddingService } from './document-unit-embedding.service.js';
import { LocalVisualHashProvider } from './local-visual-hash.provider.js';
import { VisualDocumentSearchService } from './visual-document-search.service.js';
import { VoyageMultimodalProvider } from './voyage-multimodal.provider.js';
import { ConsultingWebIngestService } from './consulting-web-ingest.service.js';
import { ConsultingRunTraceService } from './consulting-run-trace.service.js';
import {
  CONSULTING_WEB_INGEST_RUNNER,
  ConsultingWebIngestWorker,
  defaultConsultingWebIngestRunner,
} from './consulting-web-ingest.worker.js';
import { ConsultingTopicResolver } from './consulting-topic-resolver.service.js';
import { TelegramTopicRegistryService } from './telegram-topic-registry.service.js';
import { SpacesModule } from '../spaces/spaces.module.js';

@Module({
  imports: [DrizzleModule, SpacesModule],
  providers: [
    ConsultingTopicResolver,
    TelegramTopicRegistryService,
    ConsultingGraphRagBridge,
    CitationPostCheckService,
    EvidenceSufficiencyEvaluator,
    EvidenceDecisionStore,
    EvidenceToDecisionService,
    LocalNliProvider,
    { provide: DisabledLlmStrictJsonVerifier, useClass: HermesStrictJsonVerifier },
    ClaimVerifierService,
    ExactnessGateService,
    VerifierGatePolicyService,
    ConsultingJudgmentGuardService,
    LocalVisualHashProvider,
    VoyageMultimodalProvider,
    DocumentUnitEmbeddingService,
    VisualDocumentSearchService,
    ConsultingRunTraceService,
    ConsultingMemoryContextBuilder,
    ConsultingWebIngestService,
    { provide: CONSULTING_WEB_INGEST_RUNNER, useValue: defaultConsultingWebIngestRunner },
    ConsultingWebIngestWorker,
  ],
  exports: [ConsultingTopicResolver, TelegramTopicRegistryService, ConsultingGraphRagBridge, CitationPostCheckService, EvidenceSufficiencyEvaluator, EvidenceDecisionStore, EvidenceToDecisionService, LocalNliProvider, DisabledLlmStrictJsonVerifier, ClaimVerifierService, ExactnessGateService, VerifierGatePolicyService, ConsultingJudgmentGuardService, LocalVisualHashProvider, VoyageMultimodalProvider, DocumentUnitEmbeddingService, VisualDocumentSearchService, ConsultingRunTraceService, ConsultingMemoryContextBuilder, ConsultingWebIngestService],
})
export class ConsultingModule {}
