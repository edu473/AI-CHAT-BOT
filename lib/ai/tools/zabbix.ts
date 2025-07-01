import { tool } from 'ai';
import { z } from 'zod';
import { callZabbixAPI } from '@/lib/zabbix-api';

// --- Herramienta Principal para Consultas de Host ---
const getHostDetails = tool({
  description: 'Busca un host específico por su nombre, ID o número de serie y devuelve un resumen de su estado, incluyendo problemas activos.',
  parameters: z.object({
    identifier: z.string().describe('El nombre, ID, o número de serie del host a buscar. Por ejemplo: "FHTTA678754F" o "ID3612012281".'),
  }),
  execute: async ({ identifier }) => {
    try {
      const hosts = await callZabbixAPI('host.get', {
        output: ['hostid', 'host', 'name', 'status'],
        selectGroups: 'extend',
        search: { name: identifier },
        limit: 1,
      });

      if (!hosts || hosts.length === 0) {
        return `No se encontró ningún host con el identificador "${identifier}".`;
      }

      const host = hosts[0];
      const hostId = host.hostid;
      const hostName = host.host;
      const hostGroups = host.groups.map((g: any) => g.name).join(', ');

      const problems = await callZabbixAPI('problem.get', {
        output: 'extend',
        hostids: [hostId],
      });

      const problemCount = problems.length;
      let problemSummary = `Actualmente no hay problemas activos.`;
      if (problemCount > 0) {
        const problemNames = problems.slice(0, 3).map((p: any) => `- ${p.name}`).join('\n');
        problemSummary = `Tiene ${problemCount} problema(s) activo(s). Los más recientes son:\n${problemNames}`;
      }

      return `
Host encontrado: ${hostName}
Grupos (Zonas): ${hostGroups}
Estado: ${problemSummary}

Puedes pedirme el "historial de eventos" o "más detalles de los problemas" para este host.
      `.trim();
    } catch (error: any) {
      return { error: `Error al buscar el host: ${error.message}` };
    }
  },
});

// --- Nueva Herramienta para Items ---
const item_get = tool({
    description: "Obtiene información sobre los items (métricas) de un host, como 'ICMP ping'. Úsala para encontrar el 'itemid' necesario para otras herramientas como 'history_get'.",
    parameters: z.object({
        hostids: z.array(z.string()).describe("El ID del host para el cual buscar los items."),
        search: z.object({
            name: z.string().describe("El nombre de la métrica a buscar, por ejemplo 'ICMP ping'.")
        }).describe("Filtro de búsqueda para los items."),
        limit: z.number().optional().describe('Limita el número de resultados.'),
    }),
    execute: async (params) => {
        try {
            const items = await callZabbixAPI('item.get', { output: ["itemid", "name"], ...params });
            if (!items || items.length === 0) {
                return "No se encontró ningún item con ese nombre para el host especificado.";
            }
            // Devuelve solo la información relevante para que la IA la use.
            return items.map((item: any) => ({ itemid: item.itemid, name: item.name }));
        } catch (error: any) {
            return { error: `Error al buscar el item: ${error.message}` };
        }
    },
});

export const zabbix = {
  getHostDetails,
  item_get, // <-- Nueva herramienta
  
  host_get: tool({
    description: 'Obtiene una lista de hosts de Zabbix.',
    parameters: z.object({
      filter: z.object({}).passthrough().optional(),
      limit: z.number().optional(),
    }),
    execute: async (params) => {
      try {
        const result = await callZabbixAPI('host.get', { output: 'extend', selectGroups: 'extend', ...params });
        return result;
      } catch (error: any) {
        return { error: error.message };
      }
    },
  }),

  problem_get: tool({
    description: 'Obtiene una lista de los problemas (alertas) activos en Zabbix.',
    parameters: z.object({
      hostids: z.array(z.string()).optional(),
      limit: z.number().optional(),
    }),
    execute: async (params) => {
      try {
        const problems = await callZabbixAPI('problem.get', { output: 'extend', ...params });
         if (!problems || problems.length === 0) {
          return "No hay problemas activos actualmente.";
        }
        return `Hay ${problems.length} problema(s) activo(s).`;
      } catch (error: any) {
        return { error: error.message };
      }
    },
  }),
  
  history_get: tool({
    description: 'Accede al historial de datos de un item (métrica) específico.',
    parameters: z.object({
      itemids: z.array(z.string()).describe('IDs de los items para los que se quiere obtener el historial.'),
      time_from: z.number().optional(),
      limit: z.number().optional(),
      history: z.number().optional(),
    }),
    execute: async (params) => {
      try {
        const result = await callZabbixAPI('history.get', params);
        return result;
      } catch (error: any) {
        return { error: error.message };
      }
    },
  }),
};
