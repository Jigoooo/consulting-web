import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { PASSWORD_HASHER, ScryptPasswordHasher } from './password.js';
import { AuthController } from './auth.controller.js';
import { SignUpUseCase } from './sign-up.usecase.js';

@Module({
  imports: [DrizzleModule],
  controllers: [AuthController],
  providers: [
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    SignUpUseCase,
  ],
  exports: [SignUpUseCase, PASSWORD_HASHER],
})
export class AuthModule {}
