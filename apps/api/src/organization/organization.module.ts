import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { InvitationController } from './invitation.controller.js';
import { InvitationUseCase } from './invitation.usecase.js';

@Module({
  imports: [DrizzleModule],
  controllers: [InvitationController],
  providers: [InvitationUseCase],
  exports: [InvitationUseCase],
})
export class OrganizationModule {}
