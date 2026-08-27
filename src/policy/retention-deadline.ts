const millisecondsPerDay = 24 * 60 * 60 * 1_000;

function requireValidDate(value: Date, fieldName: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} must be a valid Date`);
  }
  return value;
}

export function calculateCasualChatExpiry(anchor: Date): Date {
  const validAnchor = requireValidDate(anchor, 'anchor');
  return new Date(validAnchor.getTime() + 60 * millisecondsPerDay);
}

export function addUtcCalendarMonths(anchor: Date, months: 12 | 24): Date {
  const validAnchor = requireValidDate(anchor, 'anchor');
  const targetMonthIndex = validAnchor.getUTCFullYear() * 12 + validAnchor.getUTCMonth() + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const finalTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(validAnchor.getUTCDate(), finalTargetDay);
  const result = new Date(0);
  result.setUTCFullYear(targetYear, targetMonth, targetDay);
  result.setUTCHours(
    validAnchor.getUTCHours(),
    validAnchor.getUTCMinutes(),
    validAnchor.getUTCSeconds(),
    validAnchor.getUTCMilliseconds(),
  );
  return result;
}

export function calculateClosedActiveClientDeadline(input: {
  readonly relationshipEndedAt?: Date;
  readonly finalPaidServiceCompletedAt?: Date;
}): { readonly anchorAt: Date; readonly expiresAt: Date } {
  const relationshipEndedAt =
    input.relationshipEndedAt === undefined
      ? undefined
      : requireValidDate(input.relationshipEndedAt, 'relationshipEndedAt');
  const finalPaidServiceCompletedAt =
    input.finalPaidServiceCompletedAt === undefined
      ? undefined
      : requireValidDate(input.finalPaidServiceCompletedAt, 'finalPaidServiceCompletedAt');

  if (relationshipEndedAt === undefined && finalPaidServiceCompletedAt === undefined) {
    throw new TypeError('An active-client close requires at least one documented anchor');
  }

  let anchorAt: Date;
  if (relationshipEndedAt === undefined) {
    if (finalPaidServiceCompletedAt === undefined) {
      throw new TypeError('An active-client close requires at least one documented anchor');
    }
    anchorAt = finalPaidServiceCompletedAt;
  } else if (
    finalPaidServiceCompletedAt === undefined ||
    relationshipEndedAt.getTime() >= finalPaidServiceCompletedAt.getTime()
  ) {
    anchorAt = relationshipEndedAt;
  } else {
    anchorAt = finalPaidServiceCompletedAt;
  }

  return {
    anchorAt: new Date(anchorAt.getTime()),
    expiresAt: addUtcCalendarMonths(anchorAt, 24),
  };
}
