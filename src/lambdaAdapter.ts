import awsLambdaFastify from '@fastify/aws-lambda';
import type { FastifyInstance } from 'fastify';

/** Content types API Gateway must pass through as binary (files the web app reads, plus opaque downloads). */
export const BINARY_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'application/octet-stream'];

type AnyEvent = Record<string, unknown> & { rawQueryString?: string };

/**
 * Rebuilds the query from `rawQueryString`, the only authoritative source in an HTTP API (payload v2) event.
 * The pre-parsed `queryStringParameters` may or may not be URL-decoded and merges repeated keys with commas,
 * so a search such as `q=Family%20Store` could otherwise reach the routes still encoded.
 */
export function normalizeEvent<T extends AnyEvent>(event: T): T & { queryStringParameters?: Record<string, string | string[]> } {
  if (typeof event.rawQueryString !== 'string') return event;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(event.rawQueryString)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return { ...event, queryStringParameters: out, multiValueQueryStringParameters: undefined };
}

/** Wraps the Fastify app as an AWS Lambda handler for API Gateway HTTP API events. */
export function wrapForLambda(app: FastifyInstance) {
  const invoke = awsLambdaFastify(app, { binaryMimeTypes: BINARY_TYPES });
  return (event: AnyEvent, context: unknown) => invoke(normalizeEvent(event) as never, context as never);
}
