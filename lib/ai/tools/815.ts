import { tool } from 'ai';
import { z } from 'zod';

/**
 * Define la herramienta para consultar el estado de un cliente en el sistema 815.
 */
export const consultarEstatus815 = tool({
  description: 'Consulta el estado y los detalles de un cliente en el sistema 815 utilizando su Customer ID.',
  parameters: z.object({
    customerID: z.string().describe('El Customer ID del cliente a consultar solo valor numerico. Por ejemplo: "1234567".'),
  }),
  execute: async ({ customerID }) => {
    try {
      const formData = new FormData();
      formData.append('action', 'Action1');
      formData.append('CID', customerID);

      // La URL de tu backend de Flask. Es recomendable usar una variable de entorno para esto.
      const flaskApiUrl = process.env.FLASK_API_URL || 'http://127.0.0.1:3000/submit815';

      const response = await fetch(flaskApiUrl, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Error al llamar a la API de Flask: ${response.statusText}`);
      }

      const data = await response.json();
      
      // La API de Flask devuelve un objeto con una clave "result".
      // Devolvemos este resultado para que el modelo de IA lo procese.
      return data.result;

    } catch (error: any) {
      console.error('Error ejecutando la herramienta consultarEstatus815:', error);
      return { error: `Error al contactar el servicio: ${error.message}` };
    }
  },
});

// Agrupamos la herramienta para una fácil importación
export const system815 = {
    consultarEstatus815,
};