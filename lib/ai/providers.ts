import {
    customProvider,
    extractReasoningMiddleware,
    wrapLanguageModel,
  } from 'ai';
  import { google } from '@ai-sdk/google';
  
  export const myProvider = customProvider({
    languageModels: {
      'chat-model': google('gemini-2.5-pro'),
      'chat-model-reasoning': wrapLanguageModel({
        model: google('gemini-2.5-pro'),
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      }),
      'title-model': google('gemini-2.5-pro'),
      'artifact-model': google('gemini-2.5-pro'),
    },
    // El proveedor de Google no soporta la generación de imágenes.
    // Se ha eliminado la sección imageModels.
  });