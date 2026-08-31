export type PrivacyIntent = 'access' | 'correction' | 'deletion' | 'marketing_opt_out';

const intents = new Map<string, PrivacyIntent>([
  ['CORRECT MY DATA', 'correction'],
  ['DELETE MY DATA', 'deletion'],
  ['REQUEST MY DATA', 'access'],
  ['STOP MARKETING', 'marketing_opt_out'],
]);

export function parsePrivacyIntent(value: unknown): PrivacyIntent | null {
  if (typeof value !== 'string') return null;

  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?]$/u, '')
    .toLocaleUpperCase('en-US');

  return intents.get(normalized) ?? null;
}
