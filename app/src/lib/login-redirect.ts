/** A relative Location avoids trusting request host headers and avoids Next's basePath prefixing. */
export function loginRedirectLocation(basePath: string, path: string): string {
  const normalizedBase = basePath.replace(/\/$/, '');
  const base = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(normalizedBase) ? normalizedBase : '';
  const fallback = `${base}/projects`;
  let rd = fallback;
  if (path.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x20\x7f]/.test(path) && !/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) {
    try {
      const parsed = new URL(path, 'https://local.invalid');
      if (parsed.origin === 'https://local.invalid' && (!base || parsed.pathname === base || parsed.pathname.startsWith(`${base}/`))) rd = `${parsed.pathname}${parsed.search}`;
    } catch { /* retain safe fallback */ }
  }
  return `/oauth2/start?rd=${encodeURIComponent(rd)}`;
}

/** Only the request Host is used, never forwarded host or protocol headers. */
export function loginRedirectUrl(host: string | null, protocol: string, location: string): string | null {
  if (!host || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/i.test(host)) return null;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  try {
    const origin = new URL(`${protocol}//${host}`);
    if (!location.startsWith('/oauth2/start?')) return null;
    return new URL(location, origin).href;
  } catch { return null; }
}
