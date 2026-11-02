import { NextResponse, type NextRequest } from 'next/server';
import { loginRedirectLocation, loginRedirectUrl } from './lib/login-redirect';

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === '/oauth2' || path.startsWith('/oauth2/') || path.startsWith('/api/') || path.startsWith('/_next/')) return NextResponse.next();
  const mode = process.env.AIEAS_AUTH_MODE;
  if (mode === 'local' || (mode === 'proxy' && request.headers.get('x-auth-request-user')?.trim())) return NextResponse.next();
  const base = request.nextUrl.basePath;
  const rd = `${base}${path}${request.nextUrl.search}`;
  const destination = loginRedirectUrl(request.headers.get('host'), request.nextUrl.protocol, loginRedirectLocation(base, rd));
  return destination ? NextResponse.redirect(destination, 307) : new NextResponse(null, { status: 400 });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)'],
};
