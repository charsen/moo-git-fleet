export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cdCommand(directory: string): string {
  return `cd ${shellQuote(directory)}`;
}
