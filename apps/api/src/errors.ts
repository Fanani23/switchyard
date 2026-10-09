import type { FlagDto } from '@switchyard/shared';

/**
 * Errors a service raises to say "the request cannot be honored". Each maps to one row of
 * SPEC.md's error table; the app's error handler turns them into responses. They all carry
 * a 4xx status, so the 5xx branch of the handler, which hides messages, never sees them.
 */
export abstract class DomainError extends Error {
  abstract readonly statusCode: number;
}

export class UnauthorizedError extends DomainError {
  readonly statusCode = 401;
  constructor() {
    super('Unauthorized');
  }
}

export class ForbiddenError extends DomainError {
  readonly statusCode = 403;
  constructor() {
    super('Forbidden');
  }
}

export class NotFoundError extends DomainError {
  readonly statusCode = 404;
  constructor() {
    super('Not found');
  }
}

export class ConflictError extends DomainError {
  readonly statusCode = 409;
  constructor(
    message: string,
    /** For a failed `expectedUpdatedAt` precondition: the flag as it is now. */
    readonly current?: FlagDto,
  ) {
    super(message);
  }
}

export interface ValidationDetail {
  path: string;
  message: string;
}

/** A request that parsed but is invalid against current state, e.g. an unknown variant. */
export class ValidationError extends DomainError {
  readonly statusCode = 400;
  constructor(readonly details: ValidationDetail[]) {
    super('Validation failed');
  }
}

export class LimitExceededError extends DomainError {
  readonly statusCode = 422;
  constructor(
    message: string,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(message);
  }
}
