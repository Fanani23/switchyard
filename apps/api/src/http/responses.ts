import {
  conflictErrorResponseSchema,
  errorResponseSchema,
  limitErrorResponseSchema,
  validationErrorResponseSchema,
} from '@switchyard/shared';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/principal.js';
import { UnauthorizedError } from '../errors.js';

/** Error responses every authenticated route can produce, for the OpenAPI document. */
export const authenticatedErrors = {
  400: validationErrorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  422: limitErrorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
} as const;

export const withConflict = { ...authenticatedErrors, 409: conflictErrorResponseSchema } as const;

export const bearerSecurity = [{ bearerAuth: [] }];

/** The principal set by the `authenticate` hook. Throws 401 if a route forgot the hook. */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}
