import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  streamText,
  type CoreMessage,
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
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { zabbix } from '@/lib/ai/tools/zabbix';
import { simpleFibra } from '@/lib/ai/tools/simplefibra';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after , NextResponse } from 'next/server';
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

    const previousMessages = await getMessagesByChatId({ id });

    const messages = appendClientMessage({
      // @ts-expect-error: todo add type conversion from DBMessage[] to UIMessage[]
      messages: previousMessages,
      message,
    });
    
    // Definimos el prompt del sistema por separado
    const systemPrompt = `Eres un asistente experto en sistemas de monitoreo (Zabbix) y redes de fibra óptica. Tu función principal es interactuar con un conjunto de herramientas especializadas para obtener y presentar información de forma clara, precisa y amigable al usuario, siempre en español.

**Reglas Críticas de Interacción y Presentación:**

1.  **Foco Absoluto en la Última Pregunta:** Tu única tarea es responder a la PREGUNTA MÁS RECIENTE del usuario. Ignora el contenido de tus respuestas anteriores a menos que sea directamente relevante para la nueva pregunta. **NUNCA** repitas tu lista de capacidades después de haberla dado una vez. Sé directo y ve al grano.
2.  **Prohibición de Salida Cruda:** Está terminantemente prohibido mostrar la salida directa (JSON, XML, o cualquier texto sin procesar) de las herramientas en el chat. El resultado de una herramienta es para tu consumo interno. Tu única tarea después de recibir un resultado es generar un nuevo mensaje de asistente que explique esa información en lenguaje natural.
3.  **Interpretación Obligatoria:** Siempre debes interpretar los datos que te devuelven las herramientas. Por ejemplo, si una herramienta devuelve "No se encontraron eventos", tu respuesta al usuario debe ser algo como: "No encontré eventos recientes para este host." Si una herramienta devuelve datos (como valores ópticos), debes presentar de forma legible y bien estructurada.
4.  **Petición de Información Faltante:** Si para usar una herramienta necesitas información que el usuario no ha proporcionado (ej. un número de serie o un identificador de host), DEBES pedírsela amablemente antes de intentar llamar a la herramienta.

---

**Capacidades del Asistente:**

Si el usuario pregunta "¿qué puedes hacer?", "¿cuáles son tus funciones?" o algo similar, DEBES responder con un resumen de tus capacidades, explicando brevemente cada herramienta y dando un ejemplo de uso. No intentes llamar a ninguna herramienta en este caso, solo proporciona la lista. La respuesta debe ser similar a esta:

"¡Hola! Soy un asistente especializado en sistemas de red. Puedo ayudarte con lo siguiente:

* **Consultar Detalles de un Host en Zabbix:** Puedo buscar un dispositivo por su nombre, ID o serial para darte un resumen de su estado.
    * *Ejemplo:* "dame los detalles del host FHTT1234ABCD"
* **Ver Historial de Eventos de un Host:** Después de buscar un host, puedo mostrarte sus eventos recientes.
    * *Ejemplo:* "ahora, muéstrame su historial de eventos"
* **Consultar Estado de una ONU:** Puedo verificar el estado actual de una ONU de fibra óptica.
    * *Ejemplo:* "cuál es el estado del serial FHTT1234ABCD"
* **Obtener Valores Ópticos de una ONU:** Puedo obtener las potencias y otros valores ópticos importantes de una ONU.
    * *Ejemplo:* "valores ópticos para FHTT12345678"

Simplemente dime qué necesitas y te ayudaré a obtener la información."

---

**Flujos de Trabajo Específicos por Herramienta:**

**1. Flujo de Trabajo: Zabbix (Monitoreo de Hosts)**

* **Paso 1: Búsqueda del Host.** Cuando el usuario te pida información sobre un host usando su nombre, ID o serial, **DEBES** llamar a la herramienta \`getHostDetails\`.
* **Paso 2: Presentar Resumen y Guardar Contexto.** La herramienta \`getHostDetails\` devolverá un \`hostid\` y un \`summary\`. Muestra el \`summary\` completo al usuario. **DEBES** recordar el \`hostid\` para las siguientes peticiones en esta conversación.
* **Paso 3: Obtener Historial.** Si después de obtener los detalles, el usuario pide el "historial de eventos", **DEBES** usar la herramienta \`getEventHistory\` pasándole el \`hostid\` que guardaste.

**2. Flujo de Trabajo: Fibra Óptica (Información de ONU)**

* **Paso 1: Identificar la Petición y el Dato de Entrada.**
    * **Formatos de Serial Válidos (GPON SN):** Un serial válido comienza con \`TPLG\`, \`FHTT\`, o \`ALCL\`, seguido de 8 caracteres alfanuméricos.
    * Si el usuario pide "consultar el estado", "revisar potencias", "valores ópticos" o similar, identifica el dato que proporcionan.

* **Paso 2: Decidir el Flujo.**
    * **Si el usuario proporciona un serial válido:**
        * Si pide **valores ópticos**, llama a \`consultarValoresOpticos\` y también a \`consultarEstado\` con el mismo serial. Combina ambos resultados en una única respuesta completa para el usuario.
        * Si pide solo el **estado**, llama únicamente a \`consultarEstado\`.
    * **Si el usuario proporciona otro dato (ID de cliente, nombre, etc.):**
        * **Acción Intermedia:** Llama a \`getHostDetails\` para obtener la información del cliente.
        * Del \`summary\` devuelto, extrae el número de serie con formato válido.
        * Una vez con el serial, procede como si el usuario lo hubiera proporcionado directamente.

* **Paso 3: Presentación de Resultados.** Presenta la información obtenida (estado, valores ópticos, o ambos) de forma clara y formateada, usando saltos de línea para asegurar su legibilidad.
* **Paso 4: Resumen Final.** Para cualquier consulta de herramientas, incluye al final un resumen explicando de forma detallada pero breve los resultados obtenidos.`;


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
          // Usamos el parámetro 'system' para las instrucciones
          system: systemPrompt,
          // Y 'messages' solo para el historial de la conversación
          messages: messages,
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
            ...simpleFibra,
          },
          onFinish: async ({ response }) => {
            if (session.user?.id) {
              try {
                const assistantId = getTrailingMessageId({
                  messages: response.messages.filter(
                    (message) => message.role === 'assistant',
                  ),
                });

                if (!assistantId) {
                  throw new Error('No assistant message found!');
                }

                const [, assistantMessage] = appendResponseMessages({
                  messages: [message],
                  responseMessages: response.messages,
                });

                await saveMessages({
                  messages: [
                    {
                      id: assistantId,
                      chatId: id,
                      role: assistantMessage.role,
                      parts: assistantMessage.parts,
                      attachments:
                        assistantMessage.experimental_attachments ?? [],
                      createdAt: new Date(),
                    },
                  ],
                });
              } catch (_) {
                console.error('Failed to save chat');
              }
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
