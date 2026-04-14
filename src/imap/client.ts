/**
 * IMAP client — thin wrapper around imapflow.
 *
 * Uses Node.js net/tls modules exposed by the nodejs_compat flag.
 */

import { ImapFlow } from "imapflow";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

function makeFlow(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
}

export async function withImap<T>(
  config: ImapConfig,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = makeFlow(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

export type { ImapFlow };
