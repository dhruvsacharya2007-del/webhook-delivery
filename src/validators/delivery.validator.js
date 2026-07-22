const { z } = require('zod');

const FAILURE_REASONS = ['RETRIES_EXHAUSTED', 'ENDPOINT_REJECTED'];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * The cursor is opaque to clients: an encoded (createdAt, id) pair. Clients
 * pass back whatever we gave them, without depending on its structure — so we
 * can change the encoding later without breaking them.
 */
function encodeCursor(createdAt, id) {
  const iso = new Date(createdAt).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separatorIndex = decoded.indexOf('|');
    if (separatorIndex === -1) return null;

    const iso = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    const createdAt = new Date(iso);

    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

const listDeliveriesSchema = z.object({
  query: z.object({
    status: z.literal('FAILED', {
      error: 'status=FAILED is required (this is the failed-delivery view)',
    }),
    endpointId: z.uuid('endpointId must be a valid UUID').optional(),
    failureReason: z.enum(FAILURE_REASONS).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT, `limit cannot exceed ${MAX_LIMIT}`)
      .default(DEFAULT_LIMIT),
    // Validated for decodability here so the service receives a usable cursor
    // or nothing. A malformed cursor is a client error, not a silent empty page.
    cursor: z
      .string()
      .optional()
      .refine((value) => value === undefined || decodeCursor(value) !== null, {
        error: 'cursor is malformed',
      }),
  }),
});

 

const idParamSchema = z.object({
  params: z.object({
    id: z.uuid('id must be a valid UUID'),
  }),
});
 
module.exports = {
  listDeliveriesSchema,
  idParamSchema,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};