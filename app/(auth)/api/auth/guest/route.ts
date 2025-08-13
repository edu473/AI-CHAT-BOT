import { auth, signIn } from '@/app/(auth)/auth';
import { isDevelopmentEnvironment } from '@/lib/constants';
import { createGuestUser } from '@/lib/db/queries';
import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const redirectUrl = searchParams.get('redirectUrl') || '/';

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  // Esta validación es clave para romper el bucle.
  // Si ya hay un token, simplemente redirige.
  if (token) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || origin;
    const absoluteRedirectUrl = new URL(redirectUrl, appUrl).toString();
    return NextResponse.redirect(absoluteRedirectUrl);
  }

  const [guestUser] = await createGuestUser();
  await signIn('guest', { ...guestUser, redirect: false });

  // Simplemente redirige. `signIn` se encargará de las cookies.
  // No es necesario llamar a `auth()` de nuevo ni establecer cookies manualmente.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || origin;
  const absoluteRedirectUrl = new URL(redirectUrl, appUrl).toString();
  const response = NextResponse.redirect(absoluteRedirectUrl);

  return response;
}