const maximumFaqInputCodePoints = 4000;

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

export function normalizeFaqText(input: unknown): string {
  if (
    typeof input !== 'string' ||
    containsUnpairedSurrogate(input) ||
    Array.from(input).length > maximumFaqInputCodePoints
  ) {
    throw new TypeError('FAQ text is invalid');
  }

  const normalized = input.normalize('NFKC').toLocaleLowerCase('en-US').replaceAll(/\s+/gu, ' ');

  if (/\p{Cc}|\p{Cf}/u.test(normalized)) {
    throw new TypeError('FAQ text is invalid');
  }

  const folded = normalized
    .replaceAll(/[\p{P}\p{S}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (folded.length === 0 || Array.from(folded).length > maximumFaqInputCodePoints) {
    throw new TypeError('FAQ text is invalid');
  }

  return folded;
}
