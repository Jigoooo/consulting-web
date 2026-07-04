import { Module } from '@nestjs/common';
import { MatrixPolicyEngine, POLICY_ENGINE } from './matrix-policy-engine.js';

@Module({
  providers: [{ provide: POLICY_ENGINE, useClass: MatrixPolicyEngine }],
  exports: [POLICY_ENGINE],
})
export class PermissionsModule {}
