/**
 * Quote one argument for a POSIX shell command.
 *
 * Recovery commands are displayed for human review and copy/paste.  Keeping
 * the quoting helper in shared code means the server and client cannot drift
 * into subtly different command grammars.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cdCommand(directory: string): string {
  return `cd ${shellQuote(directory)}`;
}
