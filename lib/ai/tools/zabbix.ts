import { tool } from 'ai';
import { z } from 'zod';
import { callZabbixAPI } from '@/lib/zabbix-api';

const getHostDetails = tool({
  description: 'Punto de partida para cualquier diagnóstico. Busca un host en Zabbix usando su nombre, Customer ID (ej: "ID3612012281") o Serial. Devuelve el `hostid` para usar en otras herramientas de Zabbix, el nombre del host, los grupos a los que pertenece (para determinar si es "Red Propia" o no) y un resumen de problemas activos. Siempre debe ser la primera herramienta a ejecutar cuando se solicita un diagnóstico completo. Si no se encuentra el cliente y se tiene el customer id se debe probar buscar en la herramienta 7750 `consultarEstatus7750`',
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
        return { error: `No se encontró ningún host con el identificador "${identifier}".` };
      }

      const host = hosts[0];
      const hostId = host.hostid;
      const hostName = host.host;
      const hostGroups = host.groups.map((g: any) => g.name).join(', ');

      const problems = await callZabbixAPI('problem.get', {
        output: 'extend',
        hostids: [hostId],
      });

      let problemSummary = `Actualmente no hay problemas activos.`;
      if (problems.length > 0) {
        const problemNames = problems.slice(0, 3).map((p: any) => `- ${p.name}`).join('\n');
        problemSummary = `Tiene ${problems.length} problema(s) activo(s). Los más recientes son:\n${problemNames}`;
      }
      
      // Devuelve un objeto con el hostid y el resumen
      return {
        hostid: hostId,
        summary: `Host encontrado: ${hostName}\nGrupos (Zonas): ${hostGroups}\nEstado: ${problemSummary}\n\nPuedes pedirme el "historial de eventos" para este host.`
      };

    } catch (error: any) {
      return { error: `Error al buscar el host: ${error.message}` };
    }
  },
});

const getEventHistory = tool({
  description: 'Obtiene el historial de eventos de disponibilidad (caídas y recuperaciones) para un host específico de Zabbix. Requiere el `hostid` que se obtiene de la herramienta `getHostDetails`.',
  parameters: z.object({
    hostid: z.string().describe('El ID numérico interno del host de Zabbix.'),
  }),
  execute: async ({ hostid }) => {
    try {
      const numericHostId = hostid.replace(/\D/g, '');

      // 1. Obtener eventos iniciales
      const events = await callZabbixAPI('event.get', {
        output: ["eventid", "name", "clock", "r_eventid"],
        hostids: [numericHostId],
        sortfield: ["clock"],
        sortorder: "DESC",
        limit: 20 // Aumentamos el límite para asegurar que capturemos eventos relevantes
      });

      if (!events || events.length === 0) {
        return `No se encontraron eventos recientes para el host con ID ${numericHostId}.`;
      }

      // 2. Filtrar eventos que tienen un r_eventid y no es "0"
      const problemEvents = events.filter((event: any) => event.r_eventid && event.r_eventid !== "0");

      if (problemEvents.length === 0) {
        return `No se encontraron eventos de problemas con recuperación para el host con ID ${numericHostId}.`;
      }

      // 3. Obtener los IDs de los eventos de recuperación
      const recoveryEventIds = problemEvents.map((event: any) => event.r_eventid);

      let recoveryEventMap: { [key: string]: any } = {};

      // 4. Obtener los detalles de los eventos de recuperación si existen
      if (recoveryEventIds.length > 0) {
        const recoveryEvents = await callZabbixAPI('event.get', {
          eventids: recoveryEventIds,
          output: ["eventid", "clock"]
        });
        recoveryEventMap = recoveryEvents.reduce((acc: any, event: any) => {
          acc[event.eventid] = event;
          return acc;
        }, {});
      }

      // 5. Formatear la salida
      const formattedEvents = problemEvents.map((event: any) => {
        const problemDate = new Date(event.clock * 1000).toLocaleString('es-ES');
        let line = `- Problema: "${event.name}" a las ${problemDate}.`;
        
        const recoveryEvent = recoveryEventMap[event.r_eventid];
        if (recoveryEvent) {
          const recoveryDate = new Date(recoveryEvent.clock * 1000).toLocaleString('es-ES');
          line += ` (Recuperado a las ${recoveryDate})`;
        }
        return line;
      }).join('\n');

      return `Historial de eventos para el host:\n${formattedEvents}`;

    } catch (error: any) {
      return { error: `Error al obtener el historial de eventos: ${error.message}` };
    }
  },
});

export const zabbix = {
  getHostDetails,
  getEventHistory,
};
