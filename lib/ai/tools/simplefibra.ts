import { tool } from 'ai';
import { z } from 'zod';

/**
 * Define la herramienta para consultar los valores ópticos de una ONU.
 * Esta herramienta se comunica con un backend de Flask para obtener los datos.
 */
export const consultarValoresOpticos = tool({
  description: 'Consulta los valores ópticos (potencia de recepción/transmisión) de una ONU en la red de INTER (Red Alquilada). Se usa cuando el `hostgroup` de Zabbix NO contiene "Red propia" O cuando en 7750 el nombre de la OLT empieza por `HUB-`. Requiere el número de serie de la ONU. Formatos validos para el Serial: TPLG00000000, FHTT00000000, o ALCL00000000 (prefijo + 8 caracteres)',
  parameters: z.object({
    serial: z.string().describe('El número de serie de la ONU a consultar. Por ejemplo: "FHTT12345678".'),
  }),
  execute: async ({ serial }) => {
    try {
      const formData = new FormData();
      formData.append('action', 'Action3');
      formData.append('serial', serial);

      // La URL de tu backend de Flask. Es recomendable usar una variable de entorno para esto.
      const flaskApiUrl = process.env.FLASK_API_URL_simplefibra || 'http://127.0.0.1:3000/submit';

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
      console.error('Error ejecutando la herramienta consultarValoresOpticos:', error);
      return { error: `Error al contactar el servicio: ${error.message}` };
    }
  },
});

/**
 * Define la herramienta para consultar el estado de una ONU.
 * Esta herramienta se comunica con un backend de Flask para obtener los datos.
 */
export const consultarEstado = tool({
  description: 'Consulta el estado general de una ONU en la red de INTER (Red Alquilada). Útil para verificar si el equipo está online. Requiere el número de serie de la ONU. Formatos validos para el Serial: TPLG00000000, FHTT00000000, o ALCL00000000 (prefijo + 8 caracteres)',
  parameters: z.object({
    serial: z.string().describe('El número de serie de la ONU para consultar su estado. Por ejemplo: "FHTT12345678".'),
  }),
  execute: async ({ serial }) => {
    try {
      const formData = new FormData();
      formData.append('action', 'Action5');
      formData.append('serial', serial);

      const flaskApiUrl = process.env.FLASK_API_URL_simplefibra || 'http://172.20.0.10:3000/submit';

      const response = await fetch(flaskApiUrl, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Error al llamar a la API de Flask para consultar estado: ${response.statusText}`);
      }

      const data = await response.json();
      return data.result;

    } catch (error: any) {
      console.error('Error ejecutando la herramienta consultarEstado:', error);
      return { error: `Error al contactar el servicio de estado: ${error.message}` };
    }
  },
});


// Agrupamos las herramientas para una fácil importación
export const simpleFibra = {
    consultarValoresOpticos,
    consultarEstado,
};
