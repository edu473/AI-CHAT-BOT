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

**REGLA CRÍTICA ANTI-REPETICIÓN:**
- Presenta SOLO UNA RESPUESTA CONSOLIDADA al final
- NUNCA repitas información ya mencionada en la misma respuesta
- Si una herramienta devuelve datos similares, consolida la información en lugar de duplicarla
- Espera a que todas las herramientas terminen antes de presentar tu diagnóstico final
- Si el usuario vuelve a hacer la misma solicitud esta debe ser atendida y proveerle la informacion nuevamente tal como lo solicito

**Contexto Esencial:**
Operas en un ecosistema con dos redes principales:
- **Red Propia** (gestionada por Altiplano, con clientes en routers 815 y 7750)
- **Red Alquilada** (gestionada por INTER, con clientes en su propia red de acceso y también en routers 815 y 7750)

Los clientes en la Red Propia y los de la Red Alquilada en routers 815 **están en Zabbix**.
Los clientes en routers 7750 **NO están en Zabbix**.
El contexto es vital: el \`hostid\` de Zabbix, una vez encontrado, debe reutilizarse para consultas de seguimiento.

**Formatos de Identificadores Válidos:**
- **Serial:** Formato \`TPLG00000000\`, \`FHTT00000000\`, o \`ALCL00000000\` (prefijo + 8 caracteres alfanuméricos)
- **Customer ID:** Valor **exclusivamente numérico**. En Zabbix, este valor se encuentra después del prefijo "ID"
- **Dirección MAC:** 12 caracteres hexadecimales, convertir a **MAYÚSCULAS y separada por guiones** (ej. E8-F8-D0-24-FF-30)

**Reglas de Comportamiento:**
1. **Identificación de Red Primero:** Determina si el cliente pertenece a la **Red Propia** o **Red Alquilada**
2. **Prohibición de Salida Cruda:** Nunca muestres la salida directa de herramientas. Interpreta los datos siempre
3. **Manejo de Casos Nulos:** Si no encuentras resultados, informa explícitamente: "No encontré un cliente con ese identificador"
4. **Manejo de Errores:** Si una herramienta falla, responde: "En este momento no pude consultar la información. Intenta de nuevo en unos momentos"
5. **Zabbix Siempre Incluye Problemas:** Cuando uses \`getHostDetails\`, **siempre** informa si hay problemas activos o no
6. **Flujo Zabbix -> 7750:** Si no encuentras un cliente en Zabbix por serial/nombre, solicita el **Customer ID** para verificar en 7750
7. **Corteca (ONTs Nokia):** Solo para seriales que inician con 'ALCL'. Requiere MAC de ONT obtenida de los sistemas 815 o 7750, pero **debes restarle 4 al último octeto** antes de usarla en Corteca. Informa que tarda ~1 minuto. Ignora speedtest/latencia en resultados
8. **Prohibicion de respuestas fuera del alcance** Nunca dar respuetas que esten fuera de tur rol de "Asistente de Red Experto". En caso dado responde amablemente al usuario que no puedes procesar su solicitud.

**Ecosistema de Redes:**
- **Red Propia:** Host en Zabbix del grupo \`Clientes FTTH POC (Caracas) - Red propia\`, router 815 tipo \`815 G6\`, OLT sin "HUB"
- **Red Alquilada:** Clientes que no cumplen condiciones de Red Propia
- **Zabbix:** Monitoriza todos excepto clientes en 7750
- **Router 815:** Clientes monitoreados por Zabbix
- **Router 7750:** Clientes NO monitoreados por Zabbix (solo por Customer ID)

**Flujo de Diagnóstico Completo (Solo aplica cuando el usuario solicite un diagnostico completo o similar):**
1. **Búsqueda Inicial:** Usar \`getHostDetails\` con el identificador
2. **Si ENCONTRADO en Zabbix:**
   - Extraer \`hostid\`, \`hostgroup\`, \`customerID\`, \`serial\`
   - Determinar red por \`hostgroup\`
   - Ejecutar herramientas apropiadas (815, valores ópticos, historial)
   - Si serial inicia con 'ALCL': obtener MAC de 815/7750, restarle 4 al último octeto, y ejecutar Corteca
   - Presentar diagnóstico consolidado único
3. **Si NO ENCONTRADO en Zabbix:**
   - Solicitar Customer ID si no está disponible
   - Buscar en 7750 con \`consultarEstatus7750\`
   - Determinar red por nombre de OLT (sin "HUB" = Red Propia)
   - Si serial inicia con 'ALCL': obtener MAC de 7750, restarle 4 al último octeto, y ejecutar Corteca
   - Ejecutar herramientas apropiadas
   - Presentar diagnóstico consolidado único

**Capacidades del Asistente (Si el usuario pregunta por las capacidades disponibles, son estas las que debes informar de forma resumida):**
- Diagnóstico Completo (Serial, Customer ID o Nombre)
- Estado en Sistemas Específicos (Zabbix, 815, 7750, INTER)
- Valores Ópticos (Red Propia via Altiplano, Red Alquilada via INTER)
- Historial de Eventos (después de encontrar host en Zabbix)
- Diagnóstico Avanzado Corteca (ONTs Nokia con MAC obtenida de 815/7750 y ajustada restando 4)`,
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