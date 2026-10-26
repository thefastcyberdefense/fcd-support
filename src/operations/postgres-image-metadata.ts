/** Inherited image metadata, never libpq connection defaults or credentials. */
export function isPostgresImageMetadata(name: string, value: string): boolean {
  switch (name) {
    case 'PG_MAJOR':
      return value === '18';
    case 'PG_VERSION':
      return /^18[.]4(?:[-+][A-Za-z0-9.+_-]{1,64})?$/u.test(value);
    case 'PGDATA':
      return value === '/var/lib/postgresql/18/docker';
    case 'PG_SHA256':
      return /^[a-f0-9]{64}$/u.test(value);
    default:
      return false;
  }
}
