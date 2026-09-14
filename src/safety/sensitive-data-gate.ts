import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';
import {
  sensitiveDataCategories,
  type SensitiveDataCategory,
  type SensitiveDataPolicy,
  type SensitiveRedactionMarker,
  type SensitiveTextInspection,
} from './sensitive-data-types.js';

const defaultPolicy: SensitiveDataPolicy = Object.freeze({
  maximumInputCodePoints: 4000,
});
const issuedInspections = new WeakSet<object>();

const markerByCategory: Readonly<
  Record<SensitiveDataCategory, SensitiveRedactionMarker['marker']>
> = Object.freeze({
  password: '[REDACTED_PASSWORD]',
  authentication_secret: '[REDACTED_AUTHENTICATION_SECRET]',
  otp: '[REDACTED_OTP]',
  recovery_code: '[REDACTED_RECOVERY_CODE]',
  api_key: '[REDACTED_API_KEY]',
  access_token: '[REDACTED_ACCESS_TOKEN]',
  cookie: '[REDACTED_COOKIE]',
  session: '[REDACTED_SESSION]',
  payment_card: '[REDACTED_PAYMENT_CARD]',
  bank_account: '[REDACTED_BANK_ACCOUNT]',
  private_key: '[REDACTED_PRIVATE_KEY]',
  credential_file: '[REDACTED_CREDENTIAL_FILE]',
  sensitive_incident_evidence: '[REDACTED_SENSITIVE_INCIDENT_EVIDENCE]',
});

interface Recognizer {
  readonly alwaysBlock: boolean;
  readonly category: SensitiveDataCategory;
  readonly expression: RegExp;
}

const recognizers: readonly Recognizer[] = [
  {
    category: 'password',
    alwaysBlock: false,
    expression:
      /(?:(?:\b(?:password|passcode|pin)\b)|(?:পাসওয়ার্ড|পিন))\s*(?::|=|\bis\b|হলো)\s*[^\s,;]{4,128}/giu,
  },
  {
    category: 'authentication_secret',
    alwaysBlock: true,
    expression:
      /(?:\b(?:client|authentication|auth)\s+secret\b\s*(?::|=|\bis\b)\s*[^\s,;]{4,256}|\bauthorization\s*:\s*basic\s+[A-Z0-9+/=_-]{4,512})/giu,
  },
  {
    category: 'otp',
    alwaysBlock: false,
    expression:
      /(?:(?:\b(?:otp|one[- ]?time(?: password| code)?)\b)|(?:ওটিপি|এককালীন কোড))\s*(?::|=|\bis\b|হলো|টি)?\s*[0-9০-৯](?:[0-9০-৯ -]{2,10}[0-9০-৯])/giu,
  },
  {
    category: 'recovery_code',
    alwaysBlock: false,
    expression:
      /(?:(?:\b(?:recovery|backup)\s+code\b)|(?:রিকভারি|ব্যাকআপ)\s+কোড)\s*(?::|=|\bis\b|হলো)?\s*[\p{L}\p{N}](?:[\p{L}\p{N}_-]{3,127})/giu,
  },
  {
    category: 'api_key',
    alwaysBlock: false,
    expression: /\bapi[-_ ]?key\b\s*(?::|=|\bis\b)\s*[^\s,;]{4,256}/giu,
  },
  {
    category: 'access_token',
    alwaysBlock: false,
    expression:
      /(?:\bbearer\s+[^\s,;]{4,512}|\b(?:access|refresh|auth)\s+token\b\s*(?::|=|\bis\b)\s*[^\s,;]{4,512})/giu,
  },
  {
    category: 'cookie',
    alwaysBlock: false,
    expression: /\bcookie\b\s*(?::|=|\bis\b)\s*[^\s,;]{4,512}/giu,
  },
  {
    category: 'session',
    alwaysBlock: false,
    expression: /\bsession(?:[-_ ]?(?:id|token))?\b\s*(?::|=|\bis\b)\s*[^\s,;]{4,512}/giu,
  },
  {
    category: 'payment_card',
    alwaysBlock: true,
    expression:
      /(?:\bcard(?:\s+(?:number|no))?\b\s*(?:(?::|=|\bis\b)\s*)?(?:[0-9][ -]?){12,18}[0-9]|\b(?:cvv|cvc)\b\s*(?::|=|\bis\b)\s*[0-9]{3,4})/giu,
  },
  {
    category: 'bank_account',
    alwaysBlock: true,
    expression:
      /\b(?:bank\s+account|account\s+number|routing\s+number|iban|swift)\b\s*(?::|=|\bis\b)\s*[A-Z0-9](?:[A-Z0-9 -]{4,63})/giu,
  },
  {
    category: 'private_key',
    alwaysBlock: true,
    expression: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/giu,
  },
  {
    category: 'credential_file',
    alwaysBlock: true,
    expression:
      /\bcredential(?:s)?\s+file\b\s*(?::|=|\bis\b)\s*[^\s,;]{3,256}|\b(?:credentials|service[-_ ]account)\.(?:json|ya?ml)\b|\b(?:id_rsa|id_ed25519)\b|(?:^|[\s/\\])\.env(?:\.[\w.-]+)?\b/giu,
  },
  {
    category: 'sensitive_incident_evidence',
    alwaysBlock: true,
    expression:
      /\b(?:memory\s+dump|core\s+dump|packet\s+capture|pcap|forensic\s+(?:archive|evidence|log)|incident\s+evidence)\b/giu,
  },
] as const;

const categoryOrder = new Map<SensitiveDataCategory, number>(
  sensitiveDataCategories.map((category, index) => [category, index]),
);

interface SensitiveMatch {
  readonly alwaysBlock: boolean;
  readonly category: SensitiveDataCategory;
  readonly end: number;
  readonly start: number;
}

function issueInspection<T extends SensitiveTextInspection>(inspection: T): T {
  issuedInspections.add(inspection);
  return inspection;
}

export function isIssuedSensitiveTextInspection(input: unknown): input is SensitiveTextInspection {
  return typeof input === 'object' && input !== null && issuedInspections.has(input);
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function blocked(
  language: KnowledgeLanguage,
  reasonCode:
    | 'excessive_input'
    | 'malformed_unicode'
    | 'multiple_sensitive_values'
    | 'redaction_ambiguous'
    | 'sensitive_data_detected',
  categories: readonly SensitiveDataCategory[] = [],
): SensitiveTextInspection {
  const uniqueCategories = [...new Set(categories)].sort(
    (left, right) => (categoryOrder.get(left) ?? 0) - (categoryOrder.get(right) ?? 0),
  );
  const markers = uniqueCategories.map((category) =>
    Object.freeze({ category, marker: markerByCategory[category] }),
  );
  return issueInspection(
    Object.freeze({
      status: 'blocked',
      language,
      reasonCode,
      categories: Object.freeze(uniqueCategories),
      markers: Object.freeze(markers),
    }),
  );
}

function findMatches(value: string): readonly SensitiveMatch[] {
  const candidates: SensitiveMatch[] = [];
  for (const recognizer of recognizers) {
    for (const match of value.matchAll(recognizer.expression)) {
      if (match[0].length === 0) continue;
      candidates.push({
        category: recognizer.category,
        alwaysBlock: recognizer.alwaysBlock,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      right.end - right.start - (left.end - left.start) ||
      (categoryOrder.get(left.category) ?? 0) - (categoryOrder.get(right.category) ?? 0),
  );
  const matches: SensitiveMatch[] = [];
  for (const candidate of candidates) {
    if (
      matches.some((existing) => candidate.start < existing.end && candidate.end > existing.start)
    ) {
      continue;
    }
    matches.push(candidate);
  }
  return matches.sort((left, right) => left.start - right.start);
}

function redactMatches(value: string, matches: readonly SensitiveMatch[]): string {
  let cursor = 0;
  const segments: string[] = [];
  for (const match of matches) {
    segments.push(value.slice(cursor, match.start), markerByCategory[match.category]);
    cursor = match.end;
  }
  segments.push(value.slice(cursor));
  return segments.join('').replaceAll(/\s+/gu, ' ').trim();
}

function hasUnambiguousSupportQuestion(value: string): boolean {
  const withoutMarkers = value.replaceAll(/\[REDACTED_[A-Z_]+\]/gu, ' ');
  const words = withoutMarkers.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 4 || !/[?？]/u.test(withoutMarkers)) return false;

  return /(?:\b(?:how|why|where|when|what|can|could|would|please|help)\b|(?:কীভাবে|কিভাবে|কেন|কোথায়|কখন|কি|কী|পারব|করব))/iu.test(
    withoutMarkers,
  );
}

export function inspectSensitiveText(
  input: string,
  language: KnowledgeLanguage,
  policy: SensitiveDataPolicy = defaultPolicy,
): SensitiveTextInspection {
  if (!Number.isSafeInteger(policy.maximumInputCodePoints) || policy.maximumInputCodePoints < 1) {
    throw new TypeError('Sensitive-data policy is invalid');
  }
  if (typeof input !== 'string' || containsUnpairedSurrogate(input)) {
    return blocked(language, 'malformed_unicode');
  }
  if (Array.from(input).length > policy.maximumInputCodePoints) {
    return blocked(language, 'excessive_input');
  }

  const normalized = input
    .normalize('NFKC')
    .replaceAll(/\r\n|[\r\n\t]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (Array.from(normalized).length > policy.maximumInputCodePoints) {
    return blocked(language, 'excessive_input');
  }
  if (/[\p{Cc}\p{Cf}]/u.test(normalized)) {
    return blocked(language, 'malformed_unicode');
  }

  const matches = findMatches(normalized);
  if (matches.length === 0) {
    return issueInspection(
      Object.freeze({
        status: 'safe',
        language,
        reasonCode: 'no_sensitive_data',
        categories: Object.freeze([]),
        markers: Object.freeze([]),
        sanitizedText: normalized,
      }),
    );
  }

  const categories = matches.map(({ category }) => category);
  if (matches.length > 1) return blocked(language, 'multiple_sensitive_values', categories);
  if (matches.some(({ alwaysBlock }) => alwaysBlock)) {
    return blocked(language, 'sensitive_data_detected', categories);
  }

  const sanitizedText = redactMatches(normalized, matches);
  if (!hasUnambiguousSupportQuestion(sanitizedText)) {
    return blocked(language, 'redaction_ambiguous', categories);
  }

  const category = matches[0]?.category;
  if (category === undefined) return blocked(language, 'redaction_ambiguous');
  return issueInspection(
    Object.freeze({
      status: 'redacted',
      language,
      reasonCode: 'sensitive_value_redacted',
      categories: Object.freeze([category]),
      markers: Object.freeze([
        Object.freeze({
          category,
          marker: markerByCategory[category],
        }),
      ]),
      sanitizedText,
    }),
  );
}
