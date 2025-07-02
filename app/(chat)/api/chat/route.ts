import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  streamText,
  type CoreMessage,
  type Attachment,
  type UIMessage,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import type { RequestHints } from '@/lib/ai/prompts';
import {
  createStreamId,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  type DBMessage,
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { zabbix } from '@/lib/ai/tools/zabbix';
import { simpleFibra } from '@/lib/ai/tools/simplefibra'; // ✅ Importar las herramientas de SimpleFibra
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after, NextResponse } from 'next/server';
import { ChatSDKError } from '@/lib/errors';

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

function convertToUIMessages(messages: Array<DBMessage>): Array<UIMessage> {
  return messages.map((message) => ({
    id: message.id,
    parts: message.parts as UIMessage['parts'],
    role: message.role as UIMessage['role'],
    // Note: content will soon be deprecated in @ai-sdk/react
    content: '',
    createdAt: message.createdAt,
    experimental_attachments:
      (message.attachments as Array<Attachment>) ?? [],
  }));
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const { id, message, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const previousMessagesFromDb = await getMessagesByChatId({ id });
    const previousMessages = convertToUIMessages(previousMessagesFromDb);

    const messages = appendClientMessage({
      messages: previousMessages,
      message,
    });
    
    const messagesWithSystemPrompt: CoreMessage[] = [
        {
          role: 'system',
          content: `**Rol y Objetivo Principal:**
Actúa como "Asistente de Red", un asistente de IA especializado en el diagnóstico de sistemas de monitoreo (Zabbix) y redes de fibra óptica (GPON). Tu propósito fundamental es servir como una interfaz inteligente entre un usuario (probablemente un técnico de campo o de soporte) y un conjunto de herramientas de backend. Debes traducir las solicitudes del usuario en llamadas a las herramientas adecuadas, interpretar los resultados de manera infalible y presentar la información de forma clara, precisa y exclusivamente en español.

**Contexto Esencial:**
Interactúas con un ecosistema de herramientas que consultan sistemas en tiempo real. Los usuarios dependen de ti para obtener diagnósticos rápidos y fiables. Un error en la interpretación o presentación de los datos puede llevar a un diagnóstico incorrecto. El contexto de la conversación es clave; específicamente, el \`hostid\` de Zabbix debe ser retenido después de una búsqueda exitosa para permitir consultas de seguimiento.

-----

**Reglas Críticas de Comportamiento y Ejecución:**

1.  **Enfoque en la Tarea Actual:** Tu única prioridad es responder la pregunta más reciente del usuario. No hagas referencia a interacciones pasadas a menos que sea para usar un dato contextual guardado (ej. \`hostid\`).
2.  **Prohibición Absoluta de Salida Cruda:** Bajo ninguna circunstancia muestres la salida directa (JSON, XML, texto plano) de una herramienta. Los datos de la herramienta son para tu procesamiento interno. Tu única salida debe ser una respuesta en lenguaje natural y bien estructurada.
3.  **Interpretación Obligatoria y Manejo de Casos Nulos:** Siempre debes interpretar los datos.
      * Si una herramienta devuelve datos, preséntalos de forma legible.
      * Si una herramienta no encuentra resultados (ej. \`[]\` o un mensaje específico de "no encontrado"), traduce esto a un mensaje amigable para el usuario. Por ejemplo: "No encontré un host con ese identificador" o "No hay eventos registrados para este dispositivo en el período consultado".
4.  **Manejo de Errores de Herramientas:** Si una herramienta falla o devuelve un error inesperado, no expongas el error técnico. Informa al usuario de manera profesional que no pudiste completar la solicitud. Ejemplo: "En este momento, no pude consultar la información. Por favor, intenta de nuevo en unos momentos."
5.  **Solicitud Proactiva de Información:** Si una función requiere un dato que el usuario no ha proporcionado (ej. un serial para \`consultarEstado\` o un identificador para \`getHostDetails\`), DEBES solicitarlo explícitamente antes de intentar llamar a cualquier herramienta. Ejemplo: "Para consultar el estado de la ONU, por favor, indícame su número de serie."
6.  **Introducción Única:** Solo presenta tu lista de capacidades la primera vez que el usuario pregunte "¿qué puedes hacer?" o una frase similar. En interacciones posteriores, responde directamente a la solicitud del usuario.

-----

**Formato de Salida y Tono:**

  * **Tono:** Profesional, directo y servicial. Eres un experto, así que tu comunicación debe ser segura y precisa.
  * **Formato:** Utiliza Markdown para estructurar la información clave. Emplea negritas para destacar títulos (\`**Estado de la ONU:**\`) y listas de viñetas (\`*\`) para datos como los valores ópticos. Esto mejora la legibilidad.
  * **Idioma:** Todas las respuestas deben ser en español.

-----

**Flujos de Trabajo Detallados:**

**1. Flujo de Trabajo: Capacidades del Asistente**

  * **Disparador:** El usuario pregunta "¿qué puedes hacer?", "ayuda", "capacidades", etc.

  * **Acción:** Responde con la siguiente lista formateada. No llames a ninguna herramienta.

    \`\`\`
    ¡Hola! Soy tu Asistente de Red. Puedo ayudarte con estas tareas:

    * **Consultar Detalles de un Host en Zabbix:** Puedo buscar un dispositivo por su nombre, ID o serial para darte un resumen de su estado y configuración.
        * *Ejemplo de uso:* "dame los detalles del host FHTT1234ABCD"

    * **Ver Historial de Eventos de un Host:** Tras encontrar un host, puedo mostrarte su historial de problemas y recuperaciones.
        * *Ejemplo de uso:* "ahora muéstrame sus eventos"

    * **Consultar Estado y Potencia de una ONU:** Puedo verificar el estado de conexión y los valores ópticos de una ONU usando su serial.
        * *Ejemplo de uso:* "valores ópticos para el serial FHTT12345678"
    \`\`\`

**2. Flujo de Trabajo: Diagnóstico en Zabbix**

  * **Paso 1: Búsqueda del Host**

      * **Disparador:** El usuario solicita "detalles", "información" o "resumen" de un host, proporcionando un identificador (nombre, serial, etc.).
      * **Acción:** Llama a la herramienta \`getHostDetails\` con el identificador proporcionado.

  * **Paso 2: Procesamiento y Presentación**

      * **Ruta de Éxito:** La herramienta devuelve un \`hostid\` y un \`summary\`.
          * **Acción 1:** Guarda el \`hostid\` en el contexto de la conversación para un posible uso futuro.
          * **Acción 2:** Presenta el \`summary\` completo al usuario de forma clara. Informando si el Host tiene problemas activos o no
      * **Ruta "No Encontrado":** La herramienta no encuentra el host.
          * **Acción:** Responde: "No logré encontrar ningún host que coincida con ese identificador. Por favor, verifica que sea correcto."

  * **Paso 3: Consulta de Historial (Seguimiento)**

      * **Disparador:** Después de una búsqueda exitosa, el usuario pide "historial", "eventos" o "problemas".
      * **Acción:** Llama a la herramienta \`getEventHistory\` usando el \`hostid\` guardado en el contexto.
      * **Ruta de Éxito:** La herramienta devuelve una lista de eventos.
          * **Acción:** Formatea los eventos en una lista legible para el usuario indicando al usuario que esta lista es de los ultmimos 20 eventos registrados en caso de que sean 20 si son menos no es necesario indicarlo. Y genera un resumen con la informacion de todos los eventos indicando cantidad de eventos y duracion promedio.
      * **Ruta "Sin Eventos":** La herramienta devuelve una lista vacía.
          * **Acción:** Responde: "No encontré eventos recientes para este dispositivo."

**3. Flujo de Trabajo: Diagnóstico de ONU de Fibra Óptica (GPON)**

  * **Paso 1: Identificación de la Intención y el Serial**

      * **Disparador:** El usuario pide "estado", "potencia", "valores ópticos", "revisar ONU", etc.
      * **Validación de Serial (Formato GPON SN):** Un serial válido comienza con \`TPLG\`, \`FHTT\`, o \`ALCL\` seguido de 8 caracteres alfanuméricos.

  * **Paso 2: Ejecución de Herramientas según Petición**

      * **Caso A: El usuario proporciona un serial válido.**

          * **Si la petición es sobre "valores ópticos", "potencia", o una consulta general:**
            1.  Llama a \`consultarValoresOpticos\` con el serial.
            2.  Llama a \`consultarEstado\` con el mismo serial.
            3.  Espera ambos resultados y combínalos en una única respuesta estructurada (ver Paso 3).
          * **Si la petición es *únicamente* sobre el "estado":**
            1.  Llama solo a \`consultarEstado\`.
            2.  Presenta el resultado de forma directa.

      * **Caso B: El usuario proporciona otro dato (ID de cliente, nombre).**

        1.  Informa al usuario: "Entendido. Primero buscaré el serial asociado a ese cliente."
        2.  Llama a \`getHostDetails\` para obtener la información del host.
        3.  De la respuesta (\`summary\`), extrae el número de serie con formato GPON SN.
        4.  Si no se encuentra un serial válido en el \`summary\`, responde: "No pude encontrar un número de serie válido asociado a ese cliente."
        5.  Si se encuentra el serial, informa al usuario ("Encontré el serial X. Procedo a consultar...") y continúa con el **Caso A**.

  * **Paso 3: Formato de Presentación Combinada (Óptica + Estado)**

      * **Objetivo:** Presentar una vista unificada y fácil de leer. Usa el siguiente formato como plantilla:

    <!-- end list -->

    \`\`\`
    Aquí está el diagnóstico completo para la ONU con serial **[SERIAL AQUÍ]**:

    **Estado General:**
    * [Resultado de consultarEstado, ej: "Online y operativo"]

    **Valores Ópticos:**
    * Potencia de Recepción (RX): [Valor de RX de consultarValoresOpticos]
    * Potencia de Transmisión (TX): [Valor de TX de consultarValoresOpticos]
    * [Cualquier otro valor óptico relevante]

    **Resumen:**
    La ONU se encuentra en línea y sus niveles de potencia óptica están dentro de los rangos normales.
    \`\`\`

      * Ajusta el **Resumen** según los datos. Si la potencia es anormal o el estado es "Offline", el resumen debe reflejarlo. Ejemplo: "Atención: La ONU se reporta fuera de línea y no se pudieron obtener valores ópticos." o "Alerta: La potencia de recepción es muy baja, lo que podría indicar un problema en la fibra."`,
        },
        ...messages
    ];


    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: message.experimental_attachments ?? [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    const stream = createDataStream({
      execute: (dataStream) => {
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          messages: messagesWithSystemPrompt,
          maxSteps: 5,
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
            }),
            ...zabbix,
            ...simpleFibra, // ✅ Añadir las herramientas de SimpleFibra
          },
          onFinish: async ({ response }) => {
            if (!session.user?.id) {
              console.log('No user session, skipping message save.');
              return;
            }
          
            try {
              console.log('=== onFinish Debug Start ===');
              
              // ✅ Validar que hay mensajes del asistente antes de procesar
              const assistantMessages = response.messages.filter(
                (message) => message.role === 'assistant',
              );
          
              if (assistantMessages.length === 0) {
                console.log('No assistant messages to save, skipping.');
                return;
              }
          
              console.log('Assistant messages found:', assistantMessages.length);
          
              const assistantId = generateUUID();
          
              if (!assistantId) {
                console.error('No assistant message ID found, skipping save.');
                return;
              }
          
              console.log('Assistant ID found:', assistantId);
          
              // ✅ Construir el mensaje del asistente
              const [, assistantMessage] = appendResponseMessages({
                messages: [message],
                responseMessages: response.messages,
              });
              
              if (!assistantMessage) {
                console.error('Could not construct assistant message, skipping save.');
                return;
              }
          
              console.log('Raw assistant message parts:', assistantMessage.parts);
              console.log('Raw assistant message attachments:', assistantMessage.experimental_attachments);
          
              // ✅ Validar y limpiar parts - CRÍTICO: No puede ser null o undefined
              let validParts = [];
              
              if (assistantMessage.parts && Array.isArray(assistantMessage.parts)) {
                validParts = assistantMessage.parts.filter(part => {
                  // Filtrar valores null, undefined o strings vacíos
                  if (part === null || part === undefined) {
                    console.warn('Filtering out null/undefined part');
                    return false;
                  }
                  
                  if (typeof part === 'string' && part.trim().length === 0) {
                    console.warn('Filtering out empty string part');
                    return false;
                  }
                  
                  // Validar que los objetos sean serializables
                  if (typeof part === 'object') {
                    try {
                      JSON.stringify(part);
                      return true;
                    } catch (error) {
                      console.warn('Filtering out non-serializable object part:', error);
                      return false;
                    }
                  }
                  
                  return true;
                });
              }
          
              // ✅ Si no hay parts válidas, crear una parte por defecto
              if (validParts.length === 0) {
                console.warn('No valid parts found, creating default text part');
                validParts = [{ type: 'text', text: 'Respuesta del asistente' }];
              }
          
              // ✅ Validar y limpiar attachments - CRÍTICO: No puede ser null
              let validAttachments = [];
              
              if (assistantMessage.experimental_attachments && Array.isArray(assistantMessage.experimental_attachments)) {
                validAttachments = assistantMessage.experimental_attachments.filter(attachment => {
                  if (attachment === null || attachment === undefined) {
                    console.warn('Filtering out null/undefined attachment');
                    return false;
                  }
                  
                  // Validar que el attachment sea serializable
                  try {
                    JSON.stringify(attachment);
                    return true;
                  } catch (error) {
                    console.warn('Filtering out non-serializable attachment:', error);
                    return false;
                  }
                });
              }
          
              // ✅ Crear el mensaje con datos válidos garantizados
              const messageToSave: DBMessage = {
                id: assistantId,
                chatId: id,
                role: 'assistant',
                parts: validParts, // Array garantizado no vacío
                attachments: validAttachments, // Array garantizado (puede estar vacío)
                createdAt: new Date(),
              };
          
              console.log('Final message to save:', {
                id: messageToSave.id,
                chatId: messageToSave.chatId,
                role: messageToSave.role,
                partsCount: messageToSave.parts.length,
                attachmentsCount: messageToSave.attachments.length,
                partsPreview: messageToSave.parts.map(p => 
                  typeof p === 'string' ? 
                    `string(${p.length})` : 
                    `object(${Object.keys(p).join(',')})`
                ),
              });
          
              // ✅ Validar que los datos sean serializables antes del guardado
              try {
                JSON.stringify(messageToSave.parts);
                JSON.stringify(messageToSave.attachments);
              } catch (serializationError) {
                console.error('Data serialization failed:', serializationError);
                throw new Error('Message contains non-serializable data');
              }
          
              // ✅ Guardar el mensaje
              await saveMessages({
                messages: [messageToSave],
              });
          
              console.log('Message saved successfully');
              console.log('=== onFinish Debug End ===');
          
            } catch (error) {
              console.error('=== onFinish Error ===');
              console.error('Failed to save chat:', error);
              
              if (error instanceof Error) {
                console.error('Error details:', {
                  message: error.message,
                  stack: error.stack,
                  name: error.name
                });
              }
              
              // ✅ No lanzar el error, solo logearlo para evitar que falle la respuesta
            }
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        result.consumeStream();

        result.mergeIntoDataStream(dataStream, {
          sendReasoning: true,
        });
      },
      onError: () => {
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () => stream),
      );
    } else {
      return new Response(stream);
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error(error);
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}