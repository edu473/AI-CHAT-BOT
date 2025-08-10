// lib/ai/tools/corteca.ts

import { tool } from 'ai';
import { z } from 'zod';

/**
 * Define la herramienta para realizar un diagnóstico completo de Wi-Fi a través del sistema Corteca.
 * Esta herramienta envía una solicitud de diagnóstico para una dirección MAC y espera el resultado.
 *
 * NOTA IMPORTANTE: Esta operación en el backend de Flask incluye una espera de 60 segundos
 * para que el diagnóstico se complete. Esto significa que la respuesta del chatbot se retrasará
 * por ese tiempo.
 */
export const performCortecaDiagnostic = tool({
  description: 'Realiza un diagnóstico de Wi-Fi en el sistema Corteca para una dirección MAC específica y devuelve el resultado del diagnóstico.',
  parameters: z.object({
    macAddress: z.string().describe('La dirección MAC completa para la cual se desea realizar el diagnóstico, debe ser siempre en mayuscula y separado por "-". Ejemplo: "00-1A-2B-3C-4D-5E".'),
  }),
  execute: async ({ macAddress }) => {
    try {
      const flaskApiUrl = process.env.FLASK_API_URL_corteca || 'http://127.0.0.1:3000';
      
      // Realiza la llamada POST a tu endpoint /submitcorteca en Flask
      const formData = new FormData();
      formData.append('MAC', macAddress); // El Flask endpoint espera 'MAC' en form data

      const response = await fetch(`${flaskApiUrl}/submitcorteca`, {
        method: 'POST',
        body: formData, // Envía como form-data, no JSON, según tu Flask app
      });

      if (!response.ok) {
        throw new Error(`Error al llamar a la API de Flask: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.error) {
        // Si el backend de Flask devuelve un error explícito
        return { error: `Error en el diagnóstico de Corteca: ${data.error}` };
      }
      
      // Devuelve el resultado tal como lo proporciona tu Flask backend
      return { result: data.result };

    } catch (error: any) {
      console.error('Error ejecutando la herramienta performCortecaDiagnostic:', error);
      return { error: `Error al contactar el servicio de Corteca: ${error.message}` };
    }
  },
});

// Agrupamos la herramienta para una fácil importación
export const corteca = {
    performCortecaDiagnostic,
};