// ============================================================================
// Helper Functions
// ============================================================================
/** Expand leading ~ to $HOME. */
export function expandTilde(input: string): string {
  if (input.startsWith("~")) {
    const home = process.env.HOME || "";
    if (home) {
      return home + input.slice(1);
    }
  }
  return input;
}

/** Escape a string for safe use in a RegExp pattern. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safely quote a string for bash using single quotes.
 * Single quotes prevent ALL shell expansion ($, backticks, etc.).
 * Embedded single quotes are handled via: end-quote + escaped-quote + reopen-quote
 */
export function bashSingleQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
