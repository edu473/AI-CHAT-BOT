'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import { AuthForm } from '@/components/auth-form';
import { SubmitButton } from '@/components/submit-button';
import { login, type LoginActionState } from '../actions';

export default function Page() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isSuccessful, setIsSuccessful] = useState(false);

  const [state, formAction] = useActionState<LoginActionState, FormData>(
    login,
    { status: 'idle' },
  );

  useEffect(() => {
    if (state.status === 'failed') {
      toast({ type: 'error', description: 'Credenciales inválidas.' });
      setIsSuccessful(false); 
    } else if (state.status === 'invalid_data') {
      toast({ type: 'error', description: 'Error al validar los datos.' });
       setIsSuccessful(false);
    } else if (state.status === 'success') {
      setIsSuccessful(true);
      // Simplemente redirigimos. La sesión ya fue actualizada en el servidor.
      window.location.assign('/')
    }
  }, [state, router]);

  const handleSubmit = (formData: FormData) => {
    if (isSuccessful) return; 
    setEmail(formData.get('email') as string);
    formAction(formData);
  };

  return (
    <div className="flex h-dvh w-screen items-start pt-12 md:pt-0 md:items-center justify-center bg-background">
      <div className="w-full max-w-md overflow-hidden rounded-2xl flex flex-col gap-12">
        <div className="flex flex-col items-center justify-center gap-2 px-4 text-center sm:px-16">
          <h3 className="text-xl font-semibold dark:text-zinc-50">Sign In</h3>
          <p className="text-sm text-gray-500 dark:text-zinc-400">
            Usa tu email y contraseña para iniciar sesión
          </p>
        </div>
        <AuthForm action={handleSubmit} defaultEmail={email}>
          <SubmitButton isSuccessful={isSuccessful}>Sign in</SubmitButton>
        </AuthForm>
      </div>
    </div>
  );
}