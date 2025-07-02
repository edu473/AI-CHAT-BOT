import {
    customProvider,
    extractReasoningMiddleware,
    wrapLanguageModel,
  } from 'ai';
  import { google } from '@ai-sdk/google';
  
  export const myProvider = customProvider({
    languageModels: {
      'chat-model': google('gemini-2.5-flash-lite-preview-06-17'),
      'chat-model-reasoning': wrapLanguageModel({
        model: google('gemini-2.5-flash-lite-preview-06-17'),
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      }),
      'title-model': google('gemini-2.5-flash-lite-preview-06-17'),
      'artifact-model': google('gemini-2.5-flash-lite-preview-06-17'),
    },
    // El proveedor de Google no soporta la generación de imágenes.
    // Se ha eliminado la sección imageModels.
  });