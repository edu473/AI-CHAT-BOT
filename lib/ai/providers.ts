import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai';
import { google } from '@ai-sdk/google';
import { AzureOpenAI } from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import 'dotenv/config';

// --- Azure OpenAI Configuration ---
const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "https://eduar-mcu6od48-swedencentral.cognitiveservices.azure.com/";
const deployment = "TEST";
const apiVersion = "2025-01-01-preview"; // Match working curl command
const modelName = "o4-mini"; // Kept for reference

// --- Rate Limiting Configuration ---
const rateLimits = {
  tokensPerMinute: 20000,
  requestsPerMinute: 20,
};

// --- Azure OpenAI Client Initialization ---
let azureClient: AzureOpenAI;

// Initialize client with API key authentication (matching working curl)
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
 * Updated to follow the official TypeScript 2.0.0 guidelines.
 */
function createAzureLanguageModel(client: AzureOpenAI) {
  return {
    doGenerate: async (options: any) => {
      try {
        console.log('doGenerate called with options:', {
          promptLength: options.prompt?.length,
          maxTokens: options.maxTokens,
          temperature: options.temperature
        });
        
        const requestBody = {
          messages: options.prompt,
          model: "o4-mini",
          max_completion_tokens: options.maxTokens || 100000,
          // Remove temperature for o4-mini model - it only supports default (1)
          stream: false,
        };
        
        console.log('Azure OpenAI request:', JSON.stringify(requestBody, null, 2));
        
        const response = await client.chat.completions.create(requestBody);

        return {
          text: response.choices[0]?.message?.content || '',
          finishReason: response.choices[0]?.finish_reason,
          usage: {
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens,
          },
          // Include content filter results if available
          contentFilterResults: response.choices[0]?.content_filter_results,
        };
      } catch (error) {
        console.error('Azure OpenAI API error:');
        console.error('Error message:', error.message);
        console.error('Error status:', error.status);
        console.error('Error code:', error.code);
        console.error('Request that failed:', {
          messages: options.prompt,
          model: "o4-mini",
          max_completion_tokens: options.maxTokens || 100000,
          // temperature removed for o4-mini compatibility
        });
        throw error;
      }
    },
    
    doStream: async (options: any) => {
      try {
        const stream = await client.chat.completions.create({
          messages: options.prompt,
          model: "o4-mini",
          max_completion_tokens: options.maxTokens || 100000,
          // Remove temperature for o4-mini model - it only supports default (1)
          stream: true,
        });

        return { 
          stream: (async function* () {
            for await (const chunk of stream) {
              for (const choice of chunk.choices) {
                yield {
                  type: 'text-delta',
                  textDelta: choice.delta?.content || '',
                  contentFilterResults: choice.content_filter_results,
                };
              }
            }
          })()
        };
      } catch (error) {
        console.error('Azure OpenAI streaming error:', error);
        throw error;
      }
    },
  };
}

// --- Provider Configuration ---
export const myProvider = customProvider({
  languageModels: {
    // Google models with corrected naming
    'chat-model': google('gemini-2.5-flash'),
    'chat-model-reasoning': wrapLanguageModel({
      model: google('gemini-2.5-pro'),
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    }),
    // Azure OpenAI model
    'chat-model-azure-o4-mini': createAzureLanguageModel(initializeAzureClient()),
    'title-model': google('gemini-2.5-flash'),
    'artifact-model': google('gemini-2.5-flash'),
  },
});

// --- Enhanced Test Function ---
export async function testAzureConnection(): Promise<boolean> {
  try {
    console.log('Testing Azure OpenAI connection...');
    
    const client = initializeAzureClient();
    
    // Log the exact request being made
    const requestBody = {
      messages: [{ 
        role: "user", 
        content: "I am going to Paris, what should I see?" 
      }],
      model: "o4-mini",
      max_completion_tokens: 100,
      // Remove temperature for o4-mini model - it only supports default (1)
    };
    
    console.log('Request body:', JSON.stringify(requestBody, null, 2));
    console.log('Endpoint:', endpoint);
    console.log('Deployment:', deployment);
    console.log('API Version:', apiVersion);
    
    const response = await client.chat.completions.create(requestBody);

    if (response?.choices?.[0]?.message?.content) {
      console.log('Azure OpenAI test successful:', response.choices[0].message.content);
      
      // Log content filter results if available
      const filterResults = response.choices[0].content_filter_results;
      if (filterResults) {
        console.log('Content filter results:', filterResults);
      }
      
      return true;
    } else {
      console.error('Azure OpenAI test failed: No response content');
      return false;
    }
  } catch (error) {
    console.error('Azure OpenAI test failed:');
    console.error('Error message:', error.message);
    console.error('Error status:', error.status);
    console.error('Error code:', error.code);
    console.error('Full error:', error);
    return false;
  }
}

// --- Configuration Export ---
export const azureConfig = {
  endpoint,
  modelName,
  deployment,
  apiVersion,
  rateLimits,
  authenticationMethod: 'api_key',
};

// --- Client Export ---
export const getAzureClient = () => initializeAzureClient();

// --- Validation ---
if (!process.env.AZURE_API_KEY) {
  console.warn('AZURE_API_KEY not found. Azure OpenAI client will fail to initialize.');
}

// --- Development Testing ---
if (process.env.NODE_ENV === 'development') {
  console.log('Environment check:');
  console.log('- AZURE_API_KEY:', process.env.AZURE_API_KEY ? 'Set' : 'Not set');
  console.log('- AZURE_OPENAI_ENDPOINT:', process.env.AZURE_OPENAI_ENDPOINT ? 'Set' : 'Using default');
  //testAzureConnection();
}