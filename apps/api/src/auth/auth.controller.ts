import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { AuthSessionResponseSchema, LoginRequestSchema, SignUpBootstrapResponseSchema, SignUpRequestSchema } from '@consulting/contracts';
import { SignUpUseCase } from './sign-up.usecase.js';
import { AuthSessionUseCase } from './auth-session.usecase.js';
import { parseBody, parseResponse, throwDomainError } from '../http/contract-adapter.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(SignUpUseCase) private readonly signUpUseCase: SignUpUseCase,
    @Inject(AuthSessionUseCase) private readonly authSessionUseCase: AuthSessionUseCase,
  ) {}

  @Post('signup')
  async signUp(@Body() body: unknown) {
    const cmd = parseBody(SignUpRequestSchema, body);
    const result = await this.signUpUseCase.execute(cmd);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(SignUpBootstrapResponseSchema, result.value);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Headers('user-agent') userAgent?: string) {
    const req = parseBody(LoginRequestSchema, body);
    const result = await this.authSessionUseCase.login({
      email: req.email,
      password: req.password,
      ...(userAgent !== undefined ? { userAgent } : {}),
    });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(AuthSessionResponseSchema, result.value);
  }
}
