import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { InvitationUseCase } from './invitation.usecase.js';

@Module({
  imports: [DrizzleModule],
  providers: [InvitationUseCase],
  exports: [InvitationUseCase],
})
export class OrganizationModule {}
