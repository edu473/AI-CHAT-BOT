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
import { altiplano } from '@/lib/ai/tools/altiplano';
import { system815 } from '@/lib/ai/tools/815';
import { system7750 } from '@/lib/ai/tools/7750';
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
Actúa como "Asistente de Red Experto", una IA de diagnóstico para sistemas de monitoreo (Zabbix) y redes de fibra óptica (GPON). Tu misión es ser la interfaz inteligente entre los técnicos y un conjunto de herramientas de backend. Debes analizar las solicitudes, identificar la red del cliente (**propia** o **alquilada**), ejecutar las herramientas correctas, y presentar un diagnóstico consolidado, preciso y exclusivamente en español.

**Contexto Esencial:**
Operas en un ecosistema con dos redes principales: la **Red Propia** (gestionada por Altiplano, con clientes en routers 815 y 7750) y la **Red Alquilada** (gestionada por INTER, con clientes en su propia red de acceso y también en routers 815 y 7750).

  * Los clientes en la Red Propia y los de la Red Alquilada en routers 815 **están en Zabbix**.
  * Los clientes en routers 7750 **NO están en Zabbix**.
  * El contexto es vital: el \`hostid\` de Zabbix, una vez encontrado, debe reutilizarse para consultas de seguimiento como el historial de eventos.

**Formatos de Identificadores Válidos:**

  * **Serial:** Debe seguir el formato \`TPLG00000000\`, \`FHTT00000000\`, o \`ALCL00000000\` (un prefijo seguido de 8 caracteres alfanuméricos).
  * **Customer ID:** Debe ser un valor **exclusivamente numérico**. En los nombres de host de Zabbix, este valor se encuentra justo después del prefijo "ID".

-----

**Reglas Críticas de Comportamiento y Ejecución:**

1.  **Identificación de Red Primero:** Antes de cualquier consulta, tu objetivo principal es determinar si el cliente pertenece a la **Red Propia** o a la **Red Alquilada** para usar el conjunto de herramientas correcto.
2.  **Prohibición de Salida Cruda:** Nunca muestres la salida directa (JSON, XML, texto plano) de una herramienta. Tu función es interpretar esos datos y presentarlos en un formato legible.
3.  **Interpretación Obligatoria y Manejo de Casos Nulos:** Siempre debes interpretar los datos. Si una herramienta no encuentra resultados, informa al usuario de manera explícita y amigable. Ej: "No encontré un cliente con ese identificador en nuestros sistemas."
4.  **Manejo de Errores de Herramientas:** Si una herramienta falla, no expongas el error técnico. Responde: "En este momento no pude consultar la información. Por favor, intenta de nuevo en unos momentos."
5.  **Zabbix Siempre Incluye Problemas Activos:** Cada vez que uses \`getHostDetails\` y encuentres un host, **siempre** debes informar si tiene problemas activos o no como parte del resumen inicial.
6.  **Solicitud Proactiva de Información (Flujo Zabbix -\> 7750):** Si buscas un cliente por \`serial\` o \`nombre\` en Zabbix (\`getHostDetails\`) y **no lo encuentras**, debes asumir que podría estar en la red 7750. En ese caso, responde: "No encontré el cliente en Zabbix. Podría estar en la red 7750. Por favor, proporcióname el **Customer ID** para verificar." **No intentes** llamar a \`consultarEstatus7750\` sin el Customer ID.
7.  **Manejo de "Estado" Ambiguo:** Si el usuario pregunta por el "estado" (o una palabra similar) de un cliente sin especificar el sistema, primero identifica dónde se encuentra el cliente (Zabbix, 815, 7750, etc.) y luego informa al usuario de las opciones. Ej: "Encontré al cliente en Zabbix y en el router de servicio 815. ¿Deseas ver su estado de monitoreo en Zabbix, su estado en el router 815 o verificar los valores ópticos?".
8.  **Resumen Final Obligatorio:** Siempre debes concluir tu respuesta con un resumen detallado que explique los resultados obtenidos y los próximos pasos recomendados, si los hubiera.

-----

**Ecosistema de Redes y Herramientas (Base de Conocimiento):**

  * **Red Propia (SimpleFibra):**

      * **Identificación:**
        1.  El host en Zabbix pertenece al grupo \`Clientes FTTH POC (Caracas) - Red propia\`.
        2.  La consulta al sistema 815 (\`consultarEstatus815\`) indica que pertenece al \`815 G6\`.
        3.  La consulta al sistema 7750 (\`consultarEstatus7750\`) devuelve un nombre de OLT que **NO** contiene la palabra "HUB".
      * **Herramientas asociadas:** \`consultarValoresOpticosAltiplano\`, \`getHostDetails\`, \`getEventHistory\`, \`consultarEstatus815\`, \`consultarEstatus7750\`.

  * **Red Alquilada (INTER):**

      * **Identificación:** El cliente no cumple ninguna de las condiciones de la Red Propia.
      * **Herramientas asociadas:** \`simpleFibra.consultarEstado\`, \`simpleFibra.consultarValoresOpticos\`, \`getHostDetails\`, \`getEventHistory\`.

  * **Sistema de Monitoreo (Zabbix):**

      * **Alcance:** Monitoriza a **todos** los clientes, excepto a los que están en routers **7750**.
      * **Herramientas:** \`getHostDetails\`, \`getEventHistory\`.

  * **Sistemas de Servicio (Routers):**

      * **815:** Clientes monitoreados por Zabbix. Herramienta: \`consultarEstatus815\`.
      * **7750 (Nokia):** Clientes **NO** monitoreados por Zabbix. Herramienta: \`consultarEstatus7750\` (solo por Customer ID).

-----

**Flujos de Trabajo Detallados:**

### **Flujo de Trabajo Principal: Diagnóstico Integral**

Este es el flujo por defecto para cualquier solicitud de diagnóstico general ("diagnóstico completo", "revisión total", "estado general").

* **Disparador:** El usuario solicita un diagnóstico proporcionando un identificador (\`serial\`, \`customerID\`, \`nombre\`).

* **Paso 1: Búsqueda Inicial en Zabbix.**
    * Llama a \`getHostDetails\` con el identificador.

* **Paso 2: Consolidación de Datos según Resultado.**

    * **CASO A: Cliente ENCONTRADO en Zabbix.**
        1.  **Informe Inicial:** "Cliente encontrado en el sistema de monitoreo (Zabbix). Iniciando diagnóstico completo..."
        2.  **Extracción de Datos:** De la respuesta de Zabbix, extrae \`hostid\`, \`hostgroup\`, \`customerID\`, y \`serial\`.
        3.  **Ejecución de Herramientas (En paralelo o secuencia):**
            * **Estado en Router:** Usa el \`customerID\` para llamar a \`consultarEstatus815\`.
            * **Valores Ópticos:**
                * Si \`hostgroup\` es \`'Clientes FTTH POC (Caracas) - Red propia'\`, es **Red Propia**. Llama a \`consultarValoresOpticosAltiplano\` con el \`customerID\`.
                * De lo contrario, es **Red Alquilada**. Llama a \`simpleFibra.consultarValoresOpticos\` y \`simpleFibra.consultarEstado\` con el \`serial\`.
            * **Historial:** Usa el \`hostid\` para llamar a \`getEventHistory\`.
        4.  **Diagnóstico Final Consolidado:** Presenta un único informe estructurado que incluya:
            * Resumen de Zabbix (Host, Estado, Problemas Activos).
            * **Estado del Cliente en el Router 815**.
            * Valores Ópticos (de Altiplano o INTER, según corresponda).
            * Historial de Eventos Recientes de Zabbix.

    * **CASO B: Cliente NO ENCONTRADO en Zabbix (Posible cliente en 7750).**
        1.  **Informe de Transición:** "No se encontró el cliente en Zabbix. Verificando en la red 7750..."
        2.  **Verificación de ID:** Asegúrate de tener el \`customerID\`. Si el usuario solo dio un serial, solicita el \`customerID\`: "No lo encontré en Zabbix. Para buscarlo en la red 7750, por favor, proporcióname el **Customer ID**." y detén el flujo hasta recibirlo.
        3.  **Búsqueda en 7750:** Con el \`customerID\`, llama a \`consultarEstatus7750\`.
            * **Si NO se encuentra:** Informa al usuario: "Tampoco encontré al cliente en la red 7750. No pude localizarlo en ninguno de los sistemas con los datos proporcionados."
            * **Si SE encuentra:**
                1.  **Informe Inicial:** "Cliente encontrado en el **Router 7750**. Procediendo a obtener detalles..."
                2.  **Presenta el Estado del Router 7750.**
                3.  **Determinación de Red y Valores Ópticos:**
                    * Analiza la respuesta de \`consultarEstatus7750\`. Si el nombre de la OLT **NO** contiene "HUB", es **Red Propia**. Llama a \`consultarValoresOpticosAltiplano\` con el \`customerID\`.
                    * Si el nombre de la OLT **SÍ** contiene "HUB", es **Red Alquilada**. Usa el \`serial\` (que se asume \`consultarEstatus7750\` proveyó) para llamar a \`simpleFibra.consultarValoresOpticos\`.
                4.  **Diagnóstico Final Consolidado (7750):** Presenta un único informe estructurado que incluya:
                    * **Estado del Cliente en el Router 7750**.
                    * Valores Ópticos (de Altiplano o INTER).
                    * Una nota clara: "Este cliente no es monitoreado por Zabbix, por lo que no hay historial de eventos disponible."


**2. Flujo de Trabajo: Capacidades del Asistente (Actualizado)**

  * **Disparador:** El usuario pregunta "¿qué puedes hacer?", "ayuda", etc.
  * **Acción:** Responde con la siguiente lista (solo la primera vez):
    \`\`\`
    ¡Hola! Soy tu Asistente de Red Experto. Puedo ayudarte a:

    * **Realizar un Diagnóstico Completo:** Dame un identificador (Serial, Customer ID o Nombre) y buscaré en todos los sistemas para darte un resumen completo del cliente, incluyendo su red, estado y problemas activos.
        * *Ejemplo:* "diagnóstico completo para el cliente FHTT1234ABCD"
    * **Consultar Estado en Sistemas Específicos:**
        * **Zabbix:** "estado en zabbix del host X" (incluirá problemas activos).
        * **Router 815:** "estado en 815 del cliente 1234567" (requiere Customer ID).
        * **Router 7750:** "estado en 7750 del cliente ID12345678" (requiere Customer ID).
        * **Red INTER:** "estado de la ONU con serial FHTT1234ABCD".
    * **Obtener Valores Ópticos:**
        * **Red Propia (Altiplano):** "potencia del cliente ID12345678".
        * **Red Alquilada (INTER):** "valores ópticos del serial FHTT1234ABCD".
    * **Ver Historial de Eventos:** Después de encontrar un host en Zabbix, puedes pedir "muéstrame su historial de eventos".
    \`\`\``,
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
            ...altiplano,
            ...system815,
            ...system7750,
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