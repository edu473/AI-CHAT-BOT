import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai';
import { google } from '@ai-sdk/google';
import { AzureOpenAI } from 'openai';
import 'dotenv/config';
// --- Azure OpenAI Configuration ---
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "https://eduar-mcu1br8k-eastus2.cognitiveservices.azure.com/";
const deployment = "gpt-4.1";
const apiVersion = "2025-01-01-preview";
const modelName = "gpt-4.1";

// --- Azure OpenAI Client Initialization ---
let azureClient: AzureOpenAI;

function initializeAzureClient(): AzureOpenAI {
  if (azureClient) {
    return azureClient;
  }

  if (!process.env.AZURE_API_KEY) {
    throw new Error('AZURE_API_KEY environment variable is required');
  }

  azureClient = new AzureOpenAI({
    endpoint,
    apiKey: process.env.AZURE_API_KEY,
    deployment,
    apiVersion,
  });

  console.log('Azure OpenAI initialized with API key authentication');
  return azureClient;
}

/**
 * Custom language model wrapper for Azure OpenAI.
 * This version uses an async generator, compatible with your AI SDK version.
 */
function createAzureLanguageModel(client: AzureOpenAI) {
  return {
    doGenerate: async (options: any) => {
      try {
        const { prompt, maxTokens } = options;
        const requestBody = {
          messages: prompt,
          model: modelName,
          max_completion_tokens: maxTokens || 100000,
          stream: false,
        };
        const response = await client.chat.completions.create(requestBody);
        return {
          text: response.choices[0]?.message?.content || '',
          finishReason: response.choices[0]?.finish_reason,
          usage: {
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens,
          },
        };
      } catch (error: any) {
        console.error('Azure OpenAI API error in doGenerate:', error);
        throw error;
      }
    },
    
    doStream: async (options: any) => {
      try {
        const { prompt, maxTokens } = options;
        const requestBody = {
          messages: prompt,
          model: modelName,
          max_completion_tokens: maxTokens || 100000,
          stream: true,
        };

        const responseStream = await client.chat.completions.create(requestBody);

        return { 
          stream: (async function* () {
            for await (const chunk of responseStream) {
              for (const choice of chunk.choices) {
                const delta = choice.delta?.content;
                if (delta) {
                  yield {
                    type: 'text-delta' as const,
                    textDelta: delta,
                  };
                }
                // Yield finish reason when available
                if (choice.finish_reason) {
                    yield {
                        type: 'finish' as const,
                        finishReason: choice.finish_reason,
                        usage: { promptTokens: 0, completionTokens: 0 } 
                    };
                }
              }
            }
          })()
        };
      } catch (error: any) {
        console.error('Azure OpenAI streaming error:', error);
        throw error;
      }
    },
  };
}

// --- Provider Configuration ---
export const myProvider = customProvider({
  languageModels: {
    'chat-model': google('gemini-2.5-flash'),
    'chat-model-reasoning': wrapLanguageModel({
      model: google('gemini-2.5-pro'),
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    }),
    'chat-model-azure-gpt-4.1': createAzureLanguageModel(initializeAzureClient()),
    'title-model': google('gemini-2.5-flash'),
    'artifact-model': google('gemini-2.5-flash'),
  },
});

// --- Enhanced test Function ---
export async function test1AzureConnection(): Promise<boolean> {
  try {
    console.log('gpt-4.1ing Azure OpenAI connection...');
    const client = initializeAzureClient();
    const requestBody = {
      messages: [{ role: "user", content: "I am going to Paris, what should I see?" }],
      model: modelName,
      max_completion_tokens: 100,
    };
    
    console.log('gpt-4.1 Request body:', JSON.stringify(requestBody, null, 2));
    
    const response = await client.chat.completions.create(requestBody);

    if (response?.choices?.[0]?.message?.content) {
      console.log('Azure OpenAI gpt-4.1 successful:', response.choices[0].message.content);
      const filterResults = response.choices[0].content_filter_results;
      if (filterResults) {
        console.log('Content filter results:', filterResults);
      }
      return true;
    } else {
      console.error('Azure OpenAI gpt-4.1 failed: No response content');
      return false;
    }
  } catch (error: any) {
    console.error('Azure OpenAI gpt-4.1 failed:', {
      message: error.message,
      status: error.status,
      code: error.code,
      fullError: error
    });
    return false;
  }
}

// --- Configuration Export ---
export const azureConfig = {
  endpoint,
  modelName,
  deployment,
  apiVersion,
  authenticationMethod: 'api_key',
};

// --- Client Export ---
export const getAzureClient = () => initializeAzureClient();

// --- Validation ---
if (!process.env.AZURE_API_KEY) {
  console.warn('AZURE_API_KEY not found. Azure OpenAI client will fail to initialize.');
}