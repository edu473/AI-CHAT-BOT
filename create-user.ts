// create-user.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { user } from './lib/db/schema';
import { generateHashedPassword } from './lib/db/utils';
import { config } from 'dotenv';

// Cargar variables de entorno
config({ path: '.env.local' });

async function main() {
  // --- IMPORTANTE: Cambia estos valores ---
  const email = 'eduardomora473@gmail.com'; 
  const password = 'prueba';
  // -----------------------------------------

  if (!process.env.POSTGRES_URL) {
    throw new Error('La variable de entorno POSTGRES_URL no está configurada');
  }

  const client = postgres(process.env.POSTGRES_URL, { max: 1 });
  const db = drizzle(client);

  const hashedPassword = generateHashedPassword(password);

  try {
    await db.insert(user).values({ email, password: hashedPassword });
    console.log(`✅ Usuario "${email}" creado exitosamente.`);
  } catch (error) {
    console.error('❌ Error al crear el usuario:', error);
  } finally {
    // Asegúrate de cerrar la conexión
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});