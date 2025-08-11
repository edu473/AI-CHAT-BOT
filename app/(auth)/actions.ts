'use server';

import { z } from 'zod';
import { auth } from './auth';
import { compare } from 'bcrypt-ts';
import { getUser, updateUserPassword } from '@/lib/db/queries';
import { signIn } from './auth';
import { revalidatePath } from 'next/cache';

const authFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export interface LoginActionState {
  status: 'idle' | 'in_progress' | 'success' | 'failed' | 'invalid_data';
}

export const login = async (
  _: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get('email'),
      password: formData.get('password'),
    });

    await signIn('credentials', {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: 'success' };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: 'invalid_data' };
    }

    return { status: 'failed' };
  }
};

const changePasswordFormSchema = z
  .object({
    oldPassword: z.string().min(1, 'La contraseña anterior es requerida.'),
    password: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres.'),
    confirmPassword: z.string().min(6, 'La confirmación de contraseña es requerida.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Las nuevas contraseñas no coinciden.',
    path: ['confirmPassword'], // Asigna el error al campo de confirmación
  });

export interface ChangePasswordActionState {
    status: 'idle' | 'success' | 'failed' | 'invalid_data' | 'old_password_incorrect';
    message?: string; // Para mensajes de error específicos
}

export const changePassword = async (
    _: ChangePasswordActionState,
    formData: FormData,
): Promise<ChangePasswordActionState> => {
    try {
        const validatedData = changePasswordFormSchema.parse({
            oldPassword: formData.get('oldPassword'),
            password: formData.get('password'),
            confirmPassword: formData.get('confirmPassword'),
        });

        const session = await auth();
        if (!session?.user?.email) {
            return { status: 'failed', message: 'Sesión no encontrada.' };
        }

        const [currentUser] = await getUser(session.user.email);
        if (!currentUser?.password) {
            return { status: 'failed', message: 'Usuario no encontrado.' };
        }

        // Compara la contraseña anterior proporcionada con la guardada en la BD
        const isOldPasswordCorrect = await compare(
            validatedData.oldPassword,
            currentUser.password
        );

        if (!isOldPasswordCorrect) {
            return { status: 'old_password_incorrect', message: 'La contraseña anterior es incorrecta.' };
        }

        // Si todo es correcto, actualiza la contraseña
        await updateUserPassword(session.user.email, validatedData.password);
        
        revalidatePath('/');
        return { status: 'success' };
    } catch (error) {
        if (error instanceof z.ZodError) {
            return { status: 'invalid_data', message: error.errors[0].message };
        }
        console.error(error);
        return { status: 'failed', message: 'Ocurrió un error inesperado.' };
    }
}