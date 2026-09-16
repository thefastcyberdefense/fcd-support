import { z } from 'zod';

import { OUTBOUND_PURPOSES, type OutboundPurpose } from './outbound-types.js';

const opaqueReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const accountReference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const providerTemplateId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const validDate = z.instanceof(Date).refine((value) => Number.isFinite(value.getTime()));

const fixedTemplateSchema = z.strictObject({
  category: z.enum(OUTBOUND_PURPOSES),
  channel: z.literal('whatsapp'),
  channelAccountId: accountReference,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: validDate,
  locale: z.enum(['bn_BD', 'en_US']),
  providerTemplateId,
  requestKey: opaqueReference,
  templateName: z
    .string()
    .regex(/^[a-z0-9_]+$/u)
    .max(512),
  templateRef: opaqueReference,
});

export interface FixedTemplateVersionInput {
  readonly templateRef: string;
  readonly channel: 'whatsapp';
  readonly channelAccountId: string;
  readonly providerTemplateId: string;
  readonly templateName: string;
  readonly locale: 'bn_BD' | 'en_US';
  readonly category: OutboundPurpose;
  readonly contentSha256: string;
  readonly requestKey: string;
  readonly createdAt: Date;
}

export function parseFixedTemplateVersionInput(input: unknown): FixedTemplateVersionInput {
  const parsed = fixedTemplateSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid fixed outbound template');
  return Object.freeze(parsed.data);
}
