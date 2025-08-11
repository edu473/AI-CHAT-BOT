'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Form from 'next/form';
import Link from 'next/link';
import { toast } from '@/components/toast';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/submit-button';
import { Button } from '@/components/ui/button';
import { changePassword, type ChangePasswordActionState } from '../actions';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [isSuccessful, setIsSuccessful] = useState(false);

  const [state, formAction] = useActionState<ChangePasswordActionState, FormData>(
    changePassword,
    { status: 'idle' },
  );

  useEffect(() => {
    // Resetea el estado de éxito si hay un error para permitir reintentos
    if (state.status !== 'success' && state.status !== 'idle') {
      setIsSuccessful(false);
    }
      
    if (state.status === 'success') {
      toast({ type: 'success', description: 'Contraseña actualizada exitosamente.' });
      setIsSuccessful(true);
      setTimeout(() => router.push('/'), 1500); // Dar tiempo para ver el toast
    } else if (state.message) { // Usamos el mensaje del servidor para todos los errores
       toast({ type: 'error', description: state.message });
    }
  }, [state, router]);

  return (
    <div className="flex h-dvh w-screen items-start pt-12 md:pt-0 md:items-center justify-center bg-background">
      <div className="w-full max-w-md overflow-hidden rounded-2xl flex flex-col gap-12">
        <div className="flex flex-col items-center justify-center gap-2 px-4 text-center sm:px-16">
          <h3 className="text-xl font-semibold dark:text-zinc-50">Cambiar Contraseña</h3>
          <p className="text-sm text-gray-500 dark:text-zinc-400">
            Ingresa tu contraseña anterior y la nueva contraseña.
          </p>
        </div>
        <Form action={formAction} className="flex flex-col gap-4 px-4 sm:px-16">
          {/* Campo para la Contraseña Anterior */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="oldPassword"
              className="text-zinc-600 font-normal dark:text-zinc-400"
            >
              Contraseña Anterior
            </Label>
            <Input
              id="oldPassword"
              name="oldPassword"
              className="bg-muted text-md md:text-sm"
              type="password"
              required
              autoFocus
            />
          </div>

          {/* Campo para la Nueva Contraseña */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="password"
              className="text-zinc-600 font-normal dark:text-zinc-400"
            >
              Nueva Contraseña
            </Label>
            <Input
              id="password"
              name="password"
              className="bg-muted text-md md:text-sm"
              type="password"
              required
            />
          </div>
            
          {/* Campo para Confirmar la Nueva Contraseña */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="confirmPassword"
              className="text-zinc-600 font-normal dark:text-zinc-400"
            >
              Confirmar Nueva Contraseña
            </Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              className="bg-muted text-md md:text-sm"
              type="password"
              required
            />
          </div>

          <SubmitButton isSuccessful={isSuccessful}>Actualizar Contraseña</SubmitButton>
          <Button variant="ghost" asChild>
            <Link href="/">Volver</Link>
          </Button>
        </Form>
      </div>
    </div>
  );
}