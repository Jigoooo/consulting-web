/**
 * Result type — failures are data, not thrown exceptions.
 * (quality-contract-system-design pattern: validators/use-cases return Result)
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/**
 * Canonical domain error. Carries a stable machine code + human message.
 * HTTP mapping happens at the adapter layer, never in domain/application.
 */
export type DomainErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY'
  | 'PRECONDITION'
  | 'INTERNAL';

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): DomainError => (details ? { code, message, details } : { code, message });
