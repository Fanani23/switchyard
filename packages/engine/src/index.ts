/**
 * The evaluation engine. Pure: no database, no HTTP, no clock, no I/O. The same module is
 * what an in-process SDK runs, so it must not depend on anything an SDK cannot carry.
 */
export { evaluate, bucket, bucketSlot, BUCKETS } from './evaluate.js';
export type { EvaluationResult, EvaluationReason } from './evaluate.js';
export { murmur3_32 } from './murmur3.js';
