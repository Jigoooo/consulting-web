import { Body, Controller, Inject, Post } from '@nestjs/common';
import { SignUpBootstrapResponseSchema, SignUpRequestSchema } from '@consulting/contracts';
import { SignUpUseCase } from './sign-up.usecase.js';
import { parseBody, parseResponse, throwDomainError } from '../http/contract-adapter.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(SignUpUseCase) private readonly signUpUseCase: SignUpUseCase) {}

  @Post('signup')
  async signUp(@Body() body: unknown) {
    const cmd = parseBody(SignUpRequestSchema, body);
    const result = await this.signUpUseCase.execute(cmd);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(SignUpBootstrapResponseSchema, result.value);
  }
}
