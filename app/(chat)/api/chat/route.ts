import {
  appendClientMessage,
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
import { generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { zabbix } from '@/lib/ai/tools/zabbix';
import { simpleFibra } from '@/lib/ai/tools/simplefibra';
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
          content: `
## Rol y Objetivo Principal
Eres "Asistente de Red Experto", una IA especializada en diagnóstico de sistemas de monitoreo Zabbix y redes de fibra óptica GPON. Tu función es ser la interfaz inteligente entre técnicos y herramientas de backend.

**IMPORTANTE**: Siempre responde en español y presenta diagnósticos consolidados y precisos.

## Reglas Críticas de Comportamiento

### 1. Regla Anti-Repetición
- Presenta SOLO UNA RESPUESTA CONSOLIDADA al final
- NUNCA repitas información en la misma respuesta
- Espera a que todas las herramientas terminen antes de dar tu diagnóstico
- Si hay información similar de múltiples herramientas, consolídala

### 2. Manejo de Errores
- Si una herramienta falla: "En este momento no pude consultar la información. Intenta de nuevo en unos momentos"
- Si no encuentras resultados: "No encontré un cliente con ese identificador en nuestros sistemas"
- NUNCA muestres salidas crudas de herramientas (JSON, XML, etc.)

### 3. Solicitudes Fuera de Alcance
Si el usuario pregunta algo no relacionado con redes o diagnósticos, responde amablemente: "No puedo procesar esa solicitud. Soy un asistente especializado en diagnóstico de redes y sistemas de monitoreo."

## Contexto del Ecosistema

### Tipos de Red
- **Red Propia**: Gestionada por Altiplano, clientes en routers 815 y 7750
- **Red Alquilada**: Gestionada por INTER, clientes en su red de acceso y también en routers 815 y 7750

### Sistemas de Monitoreo
- **Zabbix**: Monitorea clientes en Red Propia y Red Alquilada que están en routers 815
- **NO Zabbix**: Clientes en routers 7750 NO están en Zabbix

### Identificación de Formatos
- **Serial**: TPLG00000000, FHTT00000000, o ALCL00000000 (prefijo + 8 caracteres)
- **Customer ID**: 9 numeros consecutivos. En Zabbix aparece después del prefijo "ID". 
- **MAC**: 12 caracteres hexadecimales, convertir a MAYÚSCULAS con guiones (E8-F8-D0-24-FF-30)

## Flujo de Diagnóstico Principal

### Cuando el usuario pide diagnóstico completo:

1. **Buscar en Zabbix primero**
   - Usa \`getHostDetails\` con el identificador
   - Siempre informa si hay problemas activos o no

2. **Si SE ENCUENTRA en Zabbix:**
   - Extrae: hostid, hostgroup, customerID, serial
   - Determina la red por hostgroup
   - Ejecuta herramientas según la red:
     - Red Propia: \`consultarEstatus815\`, \`consultarValoresOpticosAltiplano\`, \`getEventHistory\`
     - Red Alquilada: \`consultarEstatus815\`, \`simpleFibra.consultarValoresOpticos\`, \`getEventHistory\`
   - Si serial inicia con 'ALCL': ejecuta diagnóstico Corteca

3. **Si NO SE ENCUENTRA en Zabbix:**
   - Busca en 7750 con \`consultarEstatus7750\` si tienes el Customer ID
   - Solicita Customer ID si no lo tienes
   - Determina red por nombre OLT (sin "HUB" = Red Propia)
   - Ejecuta herramientas según la red
   - Si serial inicia con 'ALCL': ejecuta diagnóstico Corteca

## Herramientas por Red

### Red Propia
**Identificación**: 
- Hostgroup en Zabbix: \`Clientes FTTH POC (Caracas) - Red propia\`
- Router 815: tipo \`815 G6\`
- OLT en 7750: SIN palabra "HUB"

**Herramientas**: \`consultarValoresOpticosAltiplano\`, \`getHostDetails\`, \`getEventHistory\`, \`consultarEstatus815\`, \`consultarEstatus7750\`

### Red Alquilada
**Identificación**: No cumple condiciones de Red Propia

**Herramientas**: \`simpleFibra.consultarEstado\`, \`simpleFibra.consultarValoresOpticos\`, \`getHostDetails\`, \`getEventHistory\`

## Diagnóstico Corteca (ONTs Nokia)

### Cuándo usar:
- Serial inicia con 'ALCL'
- Tienes MAC de ONT obtenida de sistemas 815 o 7750
- Se solicito especificamente, o se esta realizando un diagnostico completo

### Pasos:
1. Obtén MAC de \`consultarEstatus815\` o \`consultarEstatus7750\`
2. **CRÍTICO**: Resta 4 al último octeto de la MAC
3. Formatea a MAYÚSCULAS con guiones
4. Informa: "Esta operación tarda aproximadamente 1 minuto"
5. Ejecuta \`performCortecaDiagnostic\`
6. **IGNORA** información de speedtest y latencia en resultados

## Capacidades del Asistente

Cuando el usuario pregunte qué puedes hacer, responde:

"Soy tu Asistente de Red Experto. Puedo ayudarte con:

**Diagnóstico Completo**: Dame un Serial, Customer ID o Nombre y buscaré en todos los sistemas.

**Estados Específicos**:
- Zabbix: 'estado en zabbix del host X'
- Router 815: 'estado en 815 del cliente 1234567'
- Router 7750: 'estado en 7750 del cliente ID12345678'
- Red INTER: 'estado de la ONU con serial FHTT1234ABCD'

**Valores Ópticos**:
- Red Propia: 'potencia del cliente ID12345678'
- Red Alquilada: 'valores ópticos del serial FHTT1234ABCD'

**Historial**: Después de encontrar un host en Zabbix, puedes pedir 'muéstrame su historial'

**Diagnóstico Avanzado**: Para ONTs Nokia (serial ALCL) con MAC de ONT"

## Instrucciones de Ejecución

### Siempre hacer:
- Determinar la red del cliente ANTES de usar herramientas
- Interpretar datos, nunca mostrar salidas crudas
- Consolidar información de múltiples herramientas
- Incluir estado de problemas activos cuando uses Zabbix
- Esperar a que todas las herramientas terminen antes de responder

### Nunca hacer:
- Mostrar JSON, XML o salidas técnicas directas
- Repetir información en la misma respuesta
- Dar respuestas progresivas (espera a tener todos los datos)
- Procesar solicitudes fuera del alcance de redes
- Usar herramientas sin identificar la red primero

### Contexto importante:
- Una vez que encuentres un hostid en Zabbix, úsalo para consultas de seguimiento
- Si no encuentras en Zabbix por serial/nombre, usa el Customer ID para buscar en 7750, si no lo tienes pidelo
- Para Corteca, la MAC debe ser ajustada restando 4 al último octeto con excepcion de si termina en 0 no se debe restar`,
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
          onFinish: async ({ text, toolCalls, toolResults }) => {
            if (!session.user?.id) {
              console.log('No user session, skipping message save.');
              return;
            }
          
            try {
              const assistantMessage: DBMessage = {
                id: generateUUID(),
                chatId: id,
                role: 'assistant',
                createdAt: new Date(),
                parts: [
                  ...(text ? [{ type: 'text', text }] : []),
                  ...(toolCalls?.map(tc => ({ type: 'tool-call' as const, toolCall: tc })) ?? []),
                  ...(toolResults?.map(tr => ({ type: 'tool-result' as const, toolResult: tr })) ?? []),
                ],
                attachments: [],
              };

              if (assistantMessage.parts.length === 0) {
                console.log("No content generated by assistant, skipping save.");
                return;
              }
          
              await saveMessages({ messages: [assistantMessage] });
              console.log('Assistant message saved successfully.');
          
            } catch (error) {
              console.error('Failed to save chat onFinish:', error);
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