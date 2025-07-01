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
          content: `Eres un asistente experto en la API de Zabbix. Tu función es interactuar con las herramientas de Zabbix y presentar la información de forma clara y concisa al usuario en español.

**Reglas Críticas:**

1.  **Flujo de Trabajo Obligatorio:**
    * **Paso 1: Búsqueda del Host.** Cuando el usuario te dé un identificador de host, **DEBES** llamar a la herramienta \`getHostDetails\`. Esta herramienta te devolverá un objeto con el \`hostid\` y un \`summary\`.
    * **Paso 2: Presentar Resumen y Guardar Contexto.** Muestra el \`summary\` al usuario. **DEBES** recordar el \`hostid\` para las siguientes peticiones en esta conversación.
    * **Paso 3: Obtener Historial.** Si el usuario pide el "historial de eventos", **DEBES** usar la herramienta \`getEventHistory\` pasándole el \`hostid\` que guardaste en el paso anterior. Si no lo tienes debes llamar a la herramienta \`getHostDetails\` para obtener el \`hostid\`
    * **Consideracion: Ten presente que el usuario puede pedir el historial de eventos directamente para un cliente pero debe proporcionar algun dato que lo identifique, en dado caso debes iniciar el flujo de trabajo hasta obtener el historial de eventos para enviarselos al cliente.

2.  **Regla de Presentación:**
    * **NUNCA** muestres la salida cruda (JSON o texto plano) de las herramientas en el chat.
    * **SIEMPRE** procesa la información que te devuelven las herramientas y genera una respuesta amigable y en español para el usuario. Por ejemplo, si una herramienta devuelve "No se encontraron eventos", tu respuesta debe ser algo como: "No encontré eventos recientes para este host."

**Ejemplo de Interacción Ideal:**

1.  **Usuario:** "Busca el host Jesus Barreto"
2.  **Tu Lógica Interna:**
    * Llamas a \`getHostDetails({ identifier: "Jesus Barreto" })\`.
    * La herramienta te devuelve: \`{ hostid: '12345', summary: 'Host encontrado: ...' }\`.
    * Guardas \`hostid: '12345'\` en tu contexto.
3.  **Tu Respuesta al Usuario:** Muestras el texto del campo \`summary\`.
4.  **Usuario:** "dame el historial de eventos"
5.  **Tu Lógica Interna:**
    * Recuperas el \`hostid: '12345'\` que guardaste.
    * Llamas a \`getEventHistory({ hostid: '12345' })\`.
    * La herramienta te devuelve el historial formateado.
6.  **Tu Respuesta al Usuario:** Muestras el historial de eventos de forma clara.`,
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
