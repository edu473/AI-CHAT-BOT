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
      // Paso 1: Buscar el host usando el identificador.
      const hosts = await callZabbixAPI('host.get', {
        output: ['hostid', 'host', 'name', 'status'],
        selectGroups: 'extend',
        search: {
          name: identifier,
        },
        limit: 1,
      });

      if (!hosts || hosts.length === 0) {
        return `No se encontró ningún host con el identificador "${identifier}".`;
      }

      const host = hosts[0];
      const hostId = host.hostid;
      const hostName = host.host;
      const hostGroups = host.groups.map((g: any) => g.name).join(', ');

      // Paso 2: Buscar problemas activos para ese host (SIN ORDENAMIENTO).
      const problems = await callZabbixAPI('problem.get', {
        output: 'extend',
        hostids: [hostId], // Asegúrate de que hostids sea un array
      });

      const problemCount = problems.length;
      let problemSummary = `Actualmente no hay problemas activos.`;
      if (problemCount > 0) {
        const problemNames = problems.slice(0, 3).map((p: any) => `- ${p.name}`).join('\n');
        problemSummary = `Tiene ${problemCount} problema(s) activo(s). Los más recientes son:\n${problemNames}`;
      }

      // Paso 3: Devolver un resumen completo y útil.
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


export const zabbix = {
  getHostDetails, // <-- Nueva herramienta principal

  // Herramientas más específicas que la IA puede usar si es necesario
  host_get: tool({
    description: 'Obtiene una lista de hosts de Zabbix con opciones de filtrado avanzadas.',
    parameters: z.object({
      filter: z.object({}).passthrough().optional().describe('Filtra los resultados basado en propiedades del host.'),
      groupids: z.array(z.string()).optional().describe('Devuelve solo hosts que pertenecen a los grupos dados.'),
      limit: z.number().optional().describe('Limita el número de resultados.'),
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
      hostids: z.array(z.string()).optional().describe('Devuelve solo problemas para los hosts con los IDs dados.'),
      limit: z.number().optional().describe('Limita el número de resultados.'),
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
      time_from: z.number().optional().describe('Timestamp de inicio (Unix).'),
      limit: z.number().optional().describe('Limita el número de resultados.'),
      history: z.number().optional().describe('Tipo de historial (0: numérico, 1: texto, etc.).'),
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
