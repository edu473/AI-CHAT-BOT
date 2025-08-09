'use server';

import { z } from 'zod';
import { auth } from './auth';
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

const changePasswordFormSchema = z.object({
  password: z.string().min(6),
});

export interface ChangePasswordActionState {
    status: 'idle' | 'success' | 'failed' | 'invalid_data';
}

export const changePassword = async (
    _: ChangePasswordActionState,
    formData: FormData,
): Promise<ChangePasswordActionState> => {
    try {
        const validatedData = changePasswordFormSchema.parse({
            password: formData.get('password'),
        });

        const session = await auth();
        if (!session?.user?.email) {
            return { status: 'failed' };
        }

        await updateUserPassword(session.user.email, validatedData.password);
        
        revalidatePath('/');
        return { status: 'success' };
    } catch (error) {
        if (error instanceof z.ZodError) {
            return { status: 'invalid_data' };
        }

        return { status: 'failed' };
    }
}