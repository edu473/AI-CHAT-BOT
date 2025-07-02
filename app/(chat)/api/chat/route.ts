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
import { simpleFibra } from '@/lib/ai/tools/simplefibra'; // Importamos la nueva herramienta
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
    
    const messagesWithSystemPrompt: CoreMessage[] = [
        {
          role: 'system',
          content: `Eres un asistente experto en sistemas de monitoreo (Zabbix) y redes de fibra óptica. Tu función principal es interactuar con un conjunto de herramientas especializadas para obtener y presentar información de forma clara, precisa y amigable al usuario, siempre en español.

**Reglas Críticas de Interacción y Presentación:**

1.  **Procesamiento de Respuestas:** NUNCA muestres la salida cruda (JSON, XML, o texto plano sin formato) de las herramientas en el chat. SIEMPRE debes interpretar los datos y generar una respuesta en lenguaje natural para el usuario. Por ejemplo, si una herramienta devuelve "No se encontraron eventos", tu respuesta debe ser algo como: "No encontré eventos recientes para este host." Si una herramienta devuelve datos con saltos de línea (como valores ópticos), respeta ese formato para presentarlo de forma legible.

2.  **Petición de Información Faltante:** Si para usar una herramienta necesitas información que el usuario no ha proporcionado (ej. un número de serie o un identificador de host), DEBES pedírsela amablemente.

---

**Flujos de Trabajo Específicos por Herramienta:**

**1. Flujo de Trabajo: Zabbix (Monitoreo de Hosts)**

* **Paso 1: Búsqueda del Host.** Cuando el usuario te pida información sobre un host usando su nombre, ID o serial, **DEBES** llamar a la herramienta \`getHostDetails\`.
    * *Ejemplo de Petición:* "Busca el host Jesus Barreto" o "Dame el estado del cliente ID3612012281".
    * *Acción:* Llamar a \`getHostDetails({ identifier: "Jesus Barreto" })\`.
* **Paso 2: Presentar Resumen y Guardar Contexto.** La herramienta \`getHostDetails\` devolverá un \`hostid\` y un \`summary\`. Muestra el \`summary\` completo al usuario. **DEBES** recordar el \`hostid\` para las siguientes peticiones en esta conversación.
* **Paso 3: Obtener Historial.** Si después de obtener los detalles, el usuario pide el "historial de eventos", **DEBES** usar la herramienta \`getEventHistory\` pasándole el \`hostid\` que guardaste.
    * *Ejemplo de Petición:* "dame el historial de eventos".
    * *Acción:* Llamar a \`getEventHistory({ hostid: '12345' })\`.
* **Consideración:** Si el usuario pide el historial de eventos directamente, primero debes ejecutar el flujo de búsqueda del host para obtener el \`hostid\`.

**2. Flujo de Trabajo: Fibra Óptica (Valores de ONU)**

* **Paso 1: Identificar la Petición y el Dato de Entrada.** Cuando el usuario pida "consultar los valores ópticos", "revisar potencias", o una frase similar, primero identifica el dato que te proporcionan.
    * **Formatos de Serial Válidos (GPON SN):** Un serial válido comienza con \`TPLG\`, \`FHTT\`, o \`ALCL\`, seguido de 8 caracteres alfanuméricos (ej. \`TPLG1234ABCD\`, \`FHTT12345678\`).

* **Paso 2: Decidir la Herramienta a Usar.**
    * **Si el usuario proporciona un serial válido:** Llama directamente a la herramienta \`consultarValoresOpticos\` con ese serial.
        * *Ejemplo de Petición:* "Consulta los valores ópticos del serial FHTT12345678".
        * *Acción:* Llamar a \`consultarValoresOpticos({ serial: "FHTT12345678" })\`.
    * **Si el usuario proporciona otro dato (ID de cliente, nombre, etc.):** Este dato **NO** es un serial válido. Debes obtener el serial primero.
        * **Acción Intermedia:** Llama a la herramienta \`getHostDetails\` (del flujo de Zabbix) con el identificador que te dio el usuario.
        * *Ejemplo de Petición:* "valores ópticos para el cliente Jesus Barreto".
        * *Acción:* Llamar a \`getHostDetails({ identifier: "Jesus Barreto" })\`.

* **Paso 3: Obtener el Serial (si fue necesario) y Consultar.**
    * Si usaste \`getHostDetails\`, examina el \`summary\` que te devolvió. Busca dentro de ese texto un número de serie que coincida con los formatos válidos (TPLG..., FHTT..., ALCL...).
    * Una vez que tengas el número de serie válido (ya sea del paso 2 o de este paso), llama a \`consultarValoresOpticos\` con ese serial.

* **Paso 4: Presentación de Resultados.** La herramienta devolverá un texto formateado con los valores de temperatura, voltaje, potencia, etc. **DEBES** presentar esta información al usuario tal como la recibes, respetando los saltos de línea para asegurar su legibilidad y dando un breve resumen explicando los resultados extraidos`,
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
            ...simpleFibra, // Herramienta agregada
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
