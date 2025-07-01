import { tool } from 'ai';
import { z } from 'zod';
import { callZabbixAPI } from '@/lib/zabbix-api';

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

      let problemSummary = `Actualmente no hay problemas activos.`;
      if (problems.length > 0) {
        const problemNames = problems.slice(0, 3).map((p: any) => `- ${p.name}`).join('\n');
        problemSummary = `Tiene ${problems.length} problema(s) activo(s). Los más recientes son:\n${problemNames}`;
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

const getEventHistory = tool({
  description: 'Obtiene el historial de eventos de disponibilidad para un host específico usando el método event.get. Es la herramienta principal a usar cuando el usuario pide el "historial de eventos".',
  parameters: z.object({
    hostid: z.string().describe('El ID del host para el cual obtener el historial de eventos.'),
  }),
  execute: async ({ hostid }) => {
    try {
      const numericHostId = hostid.replace(/\D/g, '');

      const allEvents = await callZabbixAPI('event.get', {
        output: ["eventid", "name", "clock", "r_eventid"],
        hostids: [numericHostId],
        sortfield: ["clock"],
        sortorder: "DESC",
        limit: 20 
      });

      // Filter for events that have a recovery event ID
      const problemEvents = allEvents.filter((event: any) => event.r_eventid !== "0");

      if (!problemEvents || problemEvents.length === 0) {
        return `No se encontraron eventos de recuperación recientes para el host con ID ${numericHostId}.`;
      }

      const recoveryEventIds = problemEvents.map((event: any) => event.r_eventid);
      
      let recoveryEventMap: { [key: string]: any } = {};
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
