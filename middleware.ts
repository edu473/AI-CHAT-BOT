import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { guestRegex, isDevelopmentEnvironment } from './lib/constants';

export async function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;

  if (pathname.startsWith('/api/auth')) {
    // This is the condition to break the redirect loop for guest auth
    if (pathname === '/api/auth/guest' && searchParams.has('redirectUrl')) {
      return NextResponse.next();
    }
    // For all other /api/auth routes, just let them proceed
    return NextResponse.next();
  }



  if (pathname.startsWith('/ping')) {
    return new Response('pong', { status: 200 });
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  // if (!token) {
  //   // If we are already on the guest auth page, don't redirect again
  //   if (pathname === '/api/auth/guest') {
  //     return NextResponse.next();
  //   }

  //   // Construye la URL de redirección usando la URL pública definida.
  //   const redirectUrl = encodeURIComponent(appUrl + pathname + request.nextUrl.search);
  //   const guestAuthUrl = new URL(`/api/auth/guest?redirectUrl=${redirectUrl}`, appUrl);

  //   return NextResponse.redirect(guestAuthUrl);
  // }

  const isGuest = guestRegex.test(token?.email ?? '');

  if (token && !isGuest && ['/login', '/register'].includes(pathname)) {
    return NextResponse.redirect(new URL('/', appUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (authentication routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - sitemap.xml (sitemap file)
     * - robots.txt (robots file)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};