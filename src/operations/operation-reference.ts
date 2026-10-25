const referencePattern = /^operation_[a-f0-9]{32}$/u;

/** Content-free backend correlation, never an authorization capability. */
export function operationApplicationName(reference: string): string {
  if (!referencePattern.test(reference)) throw new Error('operation_reference_invalid');
  return `fcd-support:${reference}`;
}

export function bindOperationConnectionString(
  connectionString: string,
  reference: string | undefined,
): string {
  if (reference === undefined) return connectionString;
  try {
    const name = operationApplicationName(reference);
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash !== '')
      throw new Error('invalid');
    url.searchParams.set('application_name', name);
    const originalOptions = url.searchParams.get('options') ?? '';
    if (/[\0\r\n]/u.test(originalOptions)) throw new Error('invalid');
    const fixedName = `-c application_name=${name}`;
    url.searchParams.set(
      'options',
      originalOptions.endsWith(fixedName)
        ? originalOptions
        : `${originalOptions}${originalOptions === '' ? '' : ' '}${fixedName}`,
    );
    return url.toString();
  } catch {
    // Never include an input URI or reference in an error.
    throw new Error('operation_reference_invalid');
  }
}
