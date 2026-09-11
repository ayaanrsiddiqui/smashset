/**
 * Refuses to touch a database that isn't local unless explicitly allowed.
 *
 * Both things guarded here — running the test suite, and applying migrations —
 * write and delete rows, and this project has already had `.env` pointing at
 * production while both commands read it by default. The guard exists so that
 * targeting production has to be an act rather than an accident; the deploy
 * pipeline sets the override precisely because that case does mean production.
 */
export function assertLocalDatabase(action: string, overrideVar: string): void {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return;
  if (process.env[overrideVar] === '1') return;

  throw new Error(
    `Refusing to ${action} a non-local database (${host}).\n` +
      `Point DATABASE_URL at a local database, or set ${overrideVar}=1 if you\n` +
      `genuinely mean to target ${host}.`
  );
}
