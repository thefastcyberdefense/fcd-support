import type { KnowledgeLanguage } from '../knowledge/knowledge-types.js';

export const safeResponseReasons = [
  'sensitive_data_blocked',
  'limit_exhausted',
  'provider_unavailable',
  'validation_failed',
  'human_escalation',
] as const;
export type SafeResponseReason = (typeof safeResponseReasons)[number];

const responses: Readonly<Record<SafeResponseReason, Readonly<Record<KnowledgeLanguage, string>>>> =
  Object.freeze({
    sensitive_data_blocked: Object.freeze({
      en: 'For your safety, sensitive information in this message was not processed automatically. Please do not send secret values again. A support specialist will review your request.',
      bn: 'আপনার নিরাপত্তার জন্য এই বার্তার সংবেদনশীল তথ্য স্বয়ংক্রিয়ভাবে প্রক্রিয়া করা হয়নি। অনুগ্রহ করে গোপন তথ্য আবার পাঠাবেন না। একজন সহায়তা প্রতিনিধি আপনার অনুরোধটি দেখবেন।',
    }),
    limit_exhausted: Object.freeze({
      en: 'Automated support has reached its current limit. A support specialist will review your request.',
      bn: 'স্বয়ংক্রিয় সহায়তার বর্তমান সীমা পূর্ণ হয়েছে। একজন সহায়তা প্রতিনিধি আপনার অনুরোধটি দেখবেন।',
    }),
    provider_unavailable: Object.freeze({
      en: 'Automated support is temporarily unavailable. A support specialist will review your request.',
      bn: 'স্বয়ংক্রিয় সহায়তা সাময়িকভাবে পাওয়া যাচ্ছে না। একজন সহায়তা প্রতিনিধি আপনার অনুরোধটি দেখবেন।',
    }),
    validation_failed: Object.freeze({
      en: 'A safe, verified automated answer could not be prepared. A support specialist will review your request.',
      bn: 'নিরাপদ ও যাচাইকৃত স্বয়ংক্রিয় উত্তর তৈরি করা যায়নি। একজন সহায়তা প্রতিনিধি আপনার অনুরোধটি দেখবেন।',
    }),
    human_escalation: Object.freeze({
      en: 'Your request has been sent to a support specialist for review.',
      bn: 'আপনার অনুরোধটি পর্যালোচনার জন্য একজন সহায়তা প্রতিনিধির কাছে পাঠানো হয়েছে।',
    }),
  });

export function safeResponse(language: KnowledgeLanguage, reason: SafeResponseReason): string {
  return responses[reason][language];
}
