import { tool } from 'ai';
import { z } from 'zod';

/**
 * Fetches active alarms from the nokia_altiplano_alarm_counts_not_ipfix table in Supabase.
 */
export const getActiveAlarmsByCustomerId = tool({
  description: 'Consulta las alarmas activas de un cliente específico en Altiplano usando su Customer ID. La herramienta busca el ID en la columna `resource_ui_name`. Usa esta herramienta siempre que el cliente este en la red propia, es decir que este en el 7750 y el nombre de la OLT no empiece por ´HUB-´ O este en el 815 G6',
  parameters: z.object({
    customerID: z.string().describe('El Customer ID del cliente a consultar. Por ejemplo: "414098032".'),
  }),
  execute: async ({ customerID }) => {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    const TABLE_NAME = "nokia_altiplano_alarm_counts_not_ipfix";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { error: "Supabase URL or Key is not configured in environment variables." };
    }

    try {
      const params = new URLSearchParams({
        select: '*',
        status: 'eq.Active',
        resource_ui_name: `ilike.%:${customerID}`, // Use ilike for case-insensitive search
        order: 'raised_time.desc',
        limit: '500',
      });

      const api_url = `${SUPABASE_URL}/rest/v1/${TABLE_NAME}?${params.toString()}`;
      const headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      };

      const response = await fetch(api_url, { headers });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Error from Supabase: ${errorData.message || response.statusText}`);
      }
      const alarms = await response.json();

      if (alarms.length === 0) {
        return `No se encontraron alarmas activas para el Customer ID: ${customerID}.`;
      }
      
      const formattedAlarms = alarms.map((alarm: any) => {
        const time = alarm.raised_time ? new Date(alarm.raised_time).toLocaleString('es-ES') : 'N/A';
        const problemType = alarm.type || 'No especificado';
        const severity = alarm.severity || 'No especificada';
        const details = alarm.text || 'Sin detalles adicionales.';
        
        return `- **Tipo:** ${problemType}\n  - **Severidad:** ${severity}\n  - **Fecha:** ${time}\n  - **Detalles:** ${details}`;
      }).join('\n\n');

      return `**Alarmas activas para el cliente ${customerID}:**\n\n${formattedAlarms}`;

    } catch (error: any) {
      console.error('Error fetching alarms from Supabase:', error);
      return { error: `Failed to fetch alarms from Supabase: ${error.message}` };
    }
  },
});


export const supabase = {
    getActiveAlarmsByCustomerId,
};