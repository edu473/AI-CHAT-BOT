import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai';
import { google } from '@ai-sdk/google';
import { AzureOpenAI } from 'openai';
import 'dotenv/config';

// --- Configuración de Azure OpenAI ---
// ¡IMPORTANTE! Asegúrate de que esta URL coincida con la de tu recurso en Azure.
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "https://eduar-mcu1br8k-eastus2.openai.azure.com/";

// El nombre del despliegue debe ser exactamente el que tienes en Azure.
const deployment = "gpt-4.1"; 
const apiVersion = "2024-05-01-preview";

// --- Inicialización del Cliente de Azure OpenAI ---
let azureClient: AzureOpenAI;

function initializeAzureClient(): AzureOpenAI {
  if (azureClient) {
    return azureClient;
  }

  if (!process.env.AZURE_API_KEY) {
    throw new Error('La variable de entorno AZURE_API_KEY es obligatoria');
  }

  // Se inicializa el cliente con la configuración correcta.
  azureClient = new AzureOpenAI({
    endpoint,
    apiKey: process.env.AZURE_API_KEY,
    apiVersion,
    // El deployment se pasa en cada llamada, no en la inicialización global.
  });

  console.log('Azure OpenAI inicializado con clave de API.');
  return azureClient;
}

/**
 * Wrapper de modelo de lenguaje personalizado para Azure OpenAI.
 */
function createAzureLanguageModel(client: AzureOpenAI) {
  return {
    doStream: async (options: any) => {
      try {
        const { prompt, maxTokens } = options;
        const requestBody = {
          messages: prompt,
          model: deployment, // Se usa el nombre del despliegue aquí.
          max_tokens: maxTokens || 8192, // Un límite razonable de tokens.
          stream: true,
        };

        const responseStream = await client.chat.completions.create(requestBody);
        console.log("Stream de Azure OpenAI recibido, procesando...");

        // Generador asíncrono para procesar el stream correctamente.
        return {
          stream: (async function* () {
            for await (const chunk of responseStream) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) {
                console.log("Chunk:", delta); // Para depuración
                yield { type: 'text-delta' as const, textDelta: delta };
              }
              if (chunk.choices[0]?.finish_reason) {
                console.log("Fin del stream:", chunk.choices[0].finish_reason);
                yield {
                  type: 'finish' as const,
                  finishReason: chunk.choices[0].finish_reason,
                  usage: { promptTokens: 0, completionTokens: 0 },
                };
              }
            }
          })(),
        };
      } catch (error: any) {
        console.error('Error de streaming de Azure OpenAI:', error);
        throw error;
      }
    },
     doGenerate: async (options: any) => {
      const { prompt, maxTokens } = options;
      const requestBody = {
        messages: prompt,
        model: deployment,
        max_tokens: maxTokens || 8192,
        stream: false,
      };
      const response = await client.chat.completions.create(requestBody);
      return {
        text: response.choices[0]?.message?.content || '',
      };
    }
  };
}


// --- Configuración del Proveedor ---
export const myProvider = customProvider({
  languageModels: {
    'chat-model': google('gemini-2.5-flash'),
    'chat-model-reasoning': wrapLanguageModel({
      model: google('gemini-2.5-pro'),
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    }),
    'chat-model-azure-o4-mini': createAzureLanguageModel(initializeAzureClient()),
    'title-model': google('gemini-2.5-flash'),
    'artifact-model': google('gemini-2.5-flash'),
  },
});