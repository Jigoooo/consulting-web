import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { ConsultingGraphRagBridge } from './consulting-graphrag-bridge.service.js';
import { ConsultingMemoryContextBuilder } from './consulting-memory-context.builder.js';
import { ConsultingWebIngestService } from './consulting-web-ingest.service.js';
import { ConsultingTopicResolver } from './consulting-topic-resolver.service.js';

@Module({
  imports: [DrizzleModule],
  providers: [ConsultingTopicResolver, ConsultingGraphRagBridge, ConsultingMemoryContextBuilder, ConsultingWebIngestService],
  exports: [ConsultingTopicResolver, ConsultingGraphRagBridge, ConsultingMemoryContextBuilder, ConsultingWebIngestService],
})
export class ConsultingModule {}
