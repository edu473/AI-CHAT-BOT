import { tool } from 'ai';
import { z } from 'zod';

/**
 * Define la herramienta para consultar los valores ópticos de una ONU de Altiplano.
 * Esta herramienta se comunica con un backend de Flask para obtener los datos.
 */
export const consultarValoresOpticosAltiplano = tool({
  description: 'Consulta los valores ópticos de una ONU (Unidad de Red Óptica) de Altiplano a través del customer ID',
  parameters: z.object({
    cid: z.string().describe('El customer id del cliente. Solo valores numericos. Por ejemplo: "4567890".'),
  }),
  execute: async ({ cid }) => {
    try {
      const formData = new FormData();
      formData.append('action', 'Action3');
      formData.append('CID', cid);

      // La URL de tu backend de Flask. Es recomendable usar una variable de entorno para esto.
      const flaskApiUrl = process.env.FLASK_API_URL || 'http://172.20.0.10:3000/submitaltiplano';

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
      console.error('Error ejecutando la herramienta consultarValoresOpticosAltiplano:', error);
      return { error: `Error al contactar el servicio: ${error.message}` };
    }
  },
});

// Agrupamos la herramienta para una fácil importación
export const altiplano = {
    consultarValoresOpticosAltiplano,
};