export const DEFAULT_CHAT_MODEL: string = 'chat-model';

export interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export const chatModels: Array<ChatModel> = [
  {
    id: 'chat-model',
    name: 'Modelo basico (Gemini 2.5 Flash)',
    description: 'Modelo basico para propositos generales',
  },
  {
    id: 'chat-model-reasoning',
    name: 'Modelo de razonamiento (Gemini 2.5 Pro)',
    description: 'Razonamiento avanzado',
  },
];
