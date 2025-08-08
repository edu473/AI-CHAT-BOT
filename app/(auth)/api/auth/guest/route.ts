import { auth, signIn } from '@/app/(auth)/auth';
import { isDevelopmentEnvironment } from '@/lib/constants';
import { createGuestUser } from '@/lib/db/queries';
import { getToken } from 'next-auth/jwt';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const redirectUrl = searchParams.get('redirectUrl') || '/';

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });



  const [guestUser] = await createGuestUser();
  await signIn('guest', { ...guestUser, redirect: false });

  const session = await auth();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || origin;
  const absoluteRedirectUrl = new URL(redirectUrl, appUrl).toString();
  const response = NextResponse.redirect(absoluteRedirectUrl);

  if (session) {
    response.cookies.set({
      name: 'session-token',
      value: session.user.id,
      httpOnly: true,
      path: '/',
      secure: !isDevelopmentEnvironment,
    });
  }

  return response;
}