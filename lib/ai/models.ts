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
    id: 'chat-model-lite',
    name: 'Modelo ligero (Gemini 2.5 Flash Lite)',
    description: 'Modelo optimizado para velocidad y eficiencia',
  },
];
