// Pure helpers for turning a user-entered endpoint URL into the artifacts the
// extension needs. Kept free of WebExtension APIs so it can be unit-tested.

/**
 * Build a WebExtension host match pattern granting access to the endpoint's
 * host. Match patterns must NOT contain a port (ports are ignored when
 * matching), so we use the bare hostname — e.g. `http://localhost:11434`
 * becomes `http://localhost/*`, which covers the endpoint on any port.
 *
 * @returns the match pattern, or null if the URL is invalid or not http(s).
 */
export function originMatchPattern(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.protocol}//${url.hostname}/*`;
}
