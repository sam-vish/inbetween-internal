import type { Env } from '../env';
import { MemoryDb } from './memory';
import { SupabaseDb } from './supabase';
import type { Db } from './types';

export * from './types';
export { MemoryDb } from './memory';
export { SupabaseDb, clientFromRow, clipFromRow, momentFromRow, streamFromRow } from './supabase';

export function createDb(env: Env): Db {
  const driver = env.DB_DRIVER ?? (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'supabase' : 'memory');
  if (driver === 'supabase') {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error('DB_DRIVER=supabase needs SUPABASE_URL + SUPABASE_SERVICE_KEY');
    return new SupabaseDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  }
  return new MemoryDb();
}
