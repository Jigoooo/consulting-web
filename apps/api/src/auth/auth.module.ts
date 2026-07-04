import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { PASSWORD_HASHER, ScryptPasswordHasher } from './password.js';
import { AuthController } from './auth.controller.js';
import { AuthSessionUseCase } from './auth-session.usecase.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { SignUpUseCase } from './sign-up.usecase.js';

@Module({
  imports: [DrizzleModule],
  controllers: [AuthController],
  providers: [
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    SignUpUseCase,
    AuthSessionUseCase,
    AccessTokenGuard,
  ],
  exports: [SignUpUseCase, AuthSessionUseCase, AccessTokenGuard, PASSWORD_HASHER],
})
export class AuthModule {}
