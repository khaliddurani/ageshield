/**
 * Request path or URL for logs. Query strings (OIDC `code`/`state`, App Proxy signatures) and fragments are dropped,
 * so logs never hold an authorization code, a state value or a verification token.
 */
export function redactPath(pathname: string): string {
  return pathname.replace(/[?#].*$/s, '');
}
