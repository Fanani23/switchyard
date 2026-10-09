/**
 * The limits table from SPEC.md, as constants. Schemas and services both read from here so
 * a limit is stated once and cannot drift between the contract and its enforcement.
 */
export const LIMITS = {
  flagsPerEnvironment: 500,
  rulesPerFlag: 20,
  variantsPerFlag: 10,
  clausesPerSegmentRule: 10,
  flagKeyLength: 64,
  requestBodyBytes: 256 * 1024,
  adminRequestsPerMinute: 100,
  rulesetRequestsPerMinute: 1000,
  sseConnectionsPerKey: 50,
  sseHeartbeatSeconds: 30,
  auditRetentionDays: 90,
} as const;

/**
 * Bounds that SPEC.md does not name but that a ruleset shipped whole to every SDK still
 * needs. Exceeding one is reported the same way as a spec limit (422).
 */
export const INTERNAL_LIMITS = {
  valuesPerClause: 100,
  clauseValueLength: 256,
  attributeNameLength: 128,
  nameLength: 200,
  descriptionLength: 1000,
  pageSize: 100,
} as const;
