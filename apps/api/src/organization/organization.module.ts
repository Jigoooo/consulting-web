import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { InvitationController } from './invitation.controller.js';
import { InvitationUseCase } from './invitation.usecase.js';

@Module({
  imports: [DrizzleModule, AuthModule, ChatModule],
  controllers: [InvitationController],
  providers: [InvitationUseCase],
  exports: [InvitationUseCase],
})
export class OrganizationModule {}
