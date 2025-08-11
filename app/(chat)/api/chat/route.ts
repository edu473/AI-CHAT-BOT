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
} from '@/lib/db/queries';
import type { DBMessage } from '@/lib/db/schema'; 
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import { zabbix } from '@/lib/ai/tools/zabbix';
import { simpleFibra } from '@/lib/ai/tools/simplefibra'; // ✅ Importar las herramientas de SimpleFibra
import { altiplano } from '@/lib/ai/tools/altiplano';
import { system815 } from '@/lib/ai/tools/815';
import { system7750 } from '@/lib/ai/tools/7750';
import { corteca } from '@/lib/ai/tools/corteca';
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

export const maxDuration = 120;

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
  try{
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
            content: `
## Rol y Objetivo
Eres un "Asistente de Red Experto", una IA de diagnóstico para sistemas Zabbix y redes GPON. Tu objetivo es actuar como una interfaz inteligente para los técnicos, utilizando herramientas de backend para obtener y consolidar información de manera precisa. Responde siempre en español.

## Directrices Clave
1.  **Respuesta Consolidada:** No des respuestas parciales. Espera a que todas las herramientas finalicen y presenta un único diagnóstico consolidado y fácil de entender.
2.  **Manejo de Errores:** Si una herramienta falla, informa amablemente que no pudiste consultar la información. Si no encuentras datos, indica que no se encontraron resultados para el identificador proporcionado.
3.  **Prohibido Mostrar Datos Crudos:** Nunca muestres salidas de herramientas en formato JSON, XML o cualquier otro formato técnico. Siempre interpreta y resume los resultados.
4.  **Enfoque:** Si te preguntan por algo no relacionado con diagnóstico de redes, indica cortésmente que no puedes procesar esa solicitud.
5.  **Autonomía y Proactividad:** Actúa con iniciativa. Si tienes la información necesaria para usar una herramienta (como un Customer ID), úsala inmediatamente para avanzar en el diagnóstico sin pedir permiso. Si el resultado de una herramienta te da la información para usar otra, encadena las llamadas hasta obtener el resultado final que el usuario solicitó. Tu objetivo es resolver la tarea, no conversar sobre los pasos.

## Capacidades
Cuando te pregunten qué puedes hacer, responde:
"Soy tu Asistente de Red Experto. Puedo ayudarte a:
- **Realizar un diagnóstico completo** de un cliente con su Serial, Customer ID o Nombre.
- **Consultar estados específicos** en Zabbix, routers 815 y 7750, y en la red de INTER.
- **Obtener valores ópticos** de clientes en la red propia y la red de INTER.
- **Mostrar el historial de eventos** de un host encontrado en Zabbix.
- **Ejecutar un diagnóstico avanzado de Wi-Fi** para ONTs Nokia (con serial ALCL).`,
          },
          ...messages.filter((msg) => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') as CoreMessage[],
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
              ...zabbix,
              ...simpleFibra,
              ...altiplano,
              ...system815,
              ...system7750,
              ...corteca, 
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
                let validParts: UIMessage['parts'] = [];
                
                if (assistantMessage.parts && Array.isArray(assistantMessage.parts)) {
                  validParts = assistantMessage.parts.filter(part => {
                    // Filtrar valores null, undefined o strings vacíos
                    if (part === null || part === undefined) {
                      console.warn('Filtering out null/undefined part');
                      return false;
                    }
                    
                    if (part.type === 'text' && part.text.trim().length === 0) {
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
                let validAttachments: Attachment[] = [];
                
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
                  attachments: validAttachments as any, // Array garantizado (puede estar vacío)
                  createdAt: new Date(),
                };
            
                console.log('Final message to save:', {
                  id: messageToSave.id,
                  chatId: messageToSave.chatId,
                  role: messageToSave.role,
                  partsCount: (messageToSave.parts as any[]).length,
                  attachmentsCount: (messageToSave.attachments as any[]).length,
                  partsPreview: (messageToSave.parts as any[]).map((p: any) => 
                    typeof p === 'string' ? 
                      `string(${p.length})` : 
                      (typeof p === 'object' && p !== null ? `object(${Object.keys(p).join(',')})` : 'unknown')
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
  catch (error) {
    // Captura cualquier error, incluyendo posibles timeouts del modelo
    console.error('[CHAT_API_ERROR]', error)
    
    // Devuelve una respuesta de error clara al cliente
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new Response('El modelo tardó demasiado en responder.', { status: 504 })
    }
    
    return new Response('Ocurrió un error al procesar tu solicitud.', { status: 500 })
  }
}