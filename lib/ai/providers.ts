import {
    customProvider,
    extractReasoningMiddleware,
    wrapLanguageModel,
  } from 'ai';
  import { google } from '@ai-sdk/google';
  
  export const myProvider = customProvider({
    languageModels: {
      'chat-model': google('gemini-2.5-flash'),
      'chat-model-reasoning': wrapLanguageModel({
        model: google('gemini-2.5-pro'),
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      }),
      'chat-model-lite': google('gemini-2.5-flash-lite'),
      'title-model': google('gemini-2.5-flash-lite'),
      'artifact-model': google('gemini-2.5-flash-lite'),
    },
    // El proveedor de Google no soporta la generación de imágenes.
    // Se ha eliminado la sección imageModels.
  });