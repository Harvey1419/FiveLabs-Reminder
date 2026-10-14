export interface DatabaseClientOptions {
  global: { fetch: typeof fetch };
  auth: { persistSession: false; autoRefreshToken: false };
}
export interface DatabaseClientDependencies<Client> {
  getEnvironment(): Readonly<Record<string, string | undefined>>;
  createClient(url: string, secret: string, options: DatabaseClientOptions): Client;
  currentTurnSignal(): AbortSignal | null | undefined;
  fetch: typeof fetch;
}

/** Capture connection settings once; resolve transport and lease cancellation per request. */
export function createDatabaseClient<Client>({
  getEnvironment, createClient, currentTurnSignal, fetch: transport,
}: DatabaseClientDependencies<Client>): Client {
  const supabaseUrl = getEnvironment().SUPABASE_URL || 'https://placeholder.supabase.co';
  const supabaseSecret = getEnvironment().SUPABASE_SECRET || 'placeholder-secret';
  return createClient(supabaseUrl, supabaseSecret, {
    global: {
      fetch: (url, options = {}) => transport(url, {
        ...options,
        signal: AbortSignal.any(
          [options.signal, currentTurnSignal(), AbortSignal.timeout(15000)]
            .filter((signal): signal is AbortSignal => Boolean(signal)),
        ),
      }),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
