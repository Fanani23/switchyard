import type { onRequestAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  apiKeyListResponseSchema,
  auditListResponseSchema,
  createdApiKeySchema,
  createEnvironmentBodySchema,
  createFlagBodySchema,
  createKeyBodySchema,
  createProjectBodySchema,
  envIdParamsSchema,
  environmentSchema,
  flagIdParamsSchema,
  flagListResponseSchema,
  flagSchema,
  keyIdParamsSchema,
  listAuditQuerySchema,
  listFlagsQuerySchema,
  projectIdParamsSchema,
  projectListResponseSchema,
  projectSchema,
  replaceRulesBodySchema,
  rulesetResponseSchema,
  updateFlagBodySchema,
} from '@switchyard/shared';
import type { Services } from '../container.js';
import type { AppInstance } from '../types.js';
import { authenticatedErrors, bearerSecurity, principalOf, withConflict } from './responses.js';
import { SSE_HEADERS, sseSink } from './sse.js';

export interface RouteContext {
  services: Services;
  authenticate: onRequestAsyncHookHandler;
  rulesetRateLimit: number;
}

const noContent = z.null().describe('No content');

/**
 * Routes parse and reply; every decision, including authorization, is the service's.
 * Authentication runs as an onRequest hook so an unauthenticated request is refused before
 * its body is parsed or validated: no key, no feedback about the payload.
 */
export function registerRoutes(app: AppInstance, ctx: RouteContext): void {
  const { services, authenticate } = ctx;

  // -------------------------------------------------------------------- Admin API
  app.post(
    '/v1/projects',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Create a project (root key only)',
        security: bearerSecurity,
        body: createProjectBodySchema,
        response: { 201: projectSchema, ...withConflict },
      },
    },
    async (req, reply) =>
      reply.code(201).send(await services.projects.create(principalOf(req), req.body)),
  );

  app.get(
    '/v1/projects',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'List projects with their environments',
        security: bearerSecurity,
        response: { 200: projectListResponseSchema, ...authenticatedErrors },
      },
    },
    async (req) => ({ items: await services.projects.list(principalOf(req)) }),
  );

  app.post(
    '/v1/projects/:projectId/environments',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Create an environment (root key only)',
        security: bearerSecurity,
        params: projectIdParamsSchema,
        body: createEnvironmentBodySchema,
        response: { 201: environmentSchema, ...withConflict },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await services.projects.createEnvironment(
            principalOf(req),
            req.params.projectId,
            req.body,
          ),
        ),
  );

  app.get(
    '/v1/environments/:envId/flags',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'List flags with their rules',
        security: bearerSecurity,
        params: envIdParamsSchema,
        querystring: listFlagsQuerySchema,
        response: { 200: flagListResponseSchema, ...authenticatedErrors },
      },
    },
    async (req) => services.flags.list(principalOf(req), req.params.envId, req.query),
  );

  app.post(
    '/v1/environments/:envId/flags',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Create a flag',
        security: bearerSecurity,
        params: envIdParamsSchema,
        body: createFlagBodySchema,
        response: { 201: flagSchema, ...withConflict },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(await services.flags.create(principalOf(req), req.params.envId, req.body)),
  );

  app.get(
    '/v1/flags/:flagId',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Get a flag',
        security: bearerSecurity,
        params: flagIdParamsSchema,
        response: { 200: flagSchema, ...authenticatedErrors },
      },
    },
    async (req) => services.flags.get(principalOf(req), req.params.flagId),
  );

  app.patch(
    '/v1/flags/:flagId',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Rename, change default, enable or disable a flag',
        security: bearerSecurity,
        params: flagIdParamsSchema,
        body: updateFlagBodySchema,
        response: { 200: flagSchema, ...withConflict },
      },
    },
    async (req) => services.flags.update(principalOf(req), req.params.flagId, req.body),
  );

  app.put(
    '/v1/flags/:flagId/rules',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Replace the ordered rule list',
        security: bearerSecurity,
        params: flagIdParamsSchema,
        body: replaceRulesBodySchema,
        response: { 200: flagSchema, ...withConflict },
      },
    },
    async (req) => services.flags.replaceRules(principalOf(req), req.params.flagId, req.body),
  );

  app.delete(
    '/v1/flags/:flagId',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Delete a flag',
        security: bearerSecurity,
        params: flagIdParamsSchema,
        response: { 204: noContent, ...authenticatedErrors },
      },
    },
    async (req, reply) => {
      await services.flags.delete(principalOf(req), req.params.flagId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/environments/:envId/audit',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Audit log, newest first',
        security: bearerSecurity,
        params: envIdParamsSchema,
        querystring: listAuditQuerySchema,
        response: { 200: auditListResponseSchema, ...authenticatedErrors },
      },
    },
    async (req) => services.audit.list(principalOf(req), req.params.envId, req.query),
  );

  app.post(
    '/v1/environments/:envId/keys',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Mint an API key; the plaintext is in this response only',
        security: bearerSecurity,
        params: envIdParamsSchema,
        body: createKeyBodySchema,
        response: { 201: createdApiKeySchema, ...authenticatedErrors },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .header('cache-control', 'no-store')
        .send(await services.keys.create(principalOf(req), req.params.envId, req.body)),
  );

  app.get(
    '/v1/environments/:envId/keys',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'List API keys (never their secrets)',
        security: bearerSecurity,
        params: envIdParamsSchema,
        response: { 200: apiKeyListResponseSchema, ...authenticatedErrors },
      },
    },
    async (req) => ({ items: await services.keys.list(principalOf(req), req.params.envId) }),
  );

  app.delete(
    '/v1/keys/:keyId',
    {
      onRequest: authenticate,
      schema: {
        tags: ['admin'],
        summary: 'Revoke an API key',
        security: bearerSecurity,
        params: keyIdParamsSchema,
        response: { 204: noContent, ...authenticatedErrors },
      },
    },
    async (req, reply) => {
      await services.keys.revoke(principalOf(req), req.params.keyId);
      return reply.code(204).send(null);
    },
  );

  // ------------------------------------------------------------------- Client API
  app.get(
    '/v1/ruleset',
    {
      onRequest: authenticate,
      config: { rateLimit: { max: ctx.rulesetRateLimit, timeWindow: '1 minute' } },
      schema: {
        tags: ['client'],
        summary: "The whole evaluable ruleset for the key's environment",
        security: bearerSecurity,
        response: { 200: rulesetResponseSchema, ...authenticatedErrors },
      },
    },
    async (req, reply) => {
      const compiled = await services.ruleset.get(principalOf(req));
      // Already serialized and cached per version (RulesetService.load): skip re-validating
      // and re-stringifying the same bytes on every request. The bytes were built from rows
      // the Zod contracts admitted, by the same mapper the schema above describes.
      return reply
        .type('application/json; charset=utf-8')
        .serializer((payload: unknown) => payload as string)
        .send(compiled.json as never);
    },
  );

  app.get(
    '/v1/stream',
    {
      onRequest: authenticate,
      config: { rateLimit: { max: ctx.rulesetRateLimit, timeWindow: '1 minute' } },
      schema: {
        tags: ['client'],
        summary: 'Server-Sent Events: `ruleset` on connect and on every change, `ping` every 30 s',
        security: bearerSecurity,
        response: {
          200: z.string().describe('text/event-stream'),
          ...authenticatedErrors,
        },
      },
    },
    async (req, reply) => {
      // Admission (key scope, per-key connection limit) and the initial read happen before
      // the reply is hijacked, so refusals are ordinary JSON errors from the error table.
      const session = await services.stream.open(principalOf(req), req.headers.authorization);
      reply.hijack();
      try {
        reply.raw.writeHead(200, SSE_HEADERS);
      } catch {
        session.release();
        return;
      }
      session.attach(sseSink(reply.raw));
    },
  );
}
