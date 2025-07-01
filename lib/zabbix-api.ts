import 'server-only';

// Estructura de una solicitud JSON-RPC estándar para Zabbix
interface ZabbixRequest {
  jsonrpc: '2.0';
  method: string;
  params: any;
  auth: string | null;
  id: number;
}

// Estructura de una respuesta JSON-RPC estándar de Zabbix
interface ZabbixResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
    data: string;
  };
  id: number;
}

/**
 * Realiza una llamada a la API de Zabbix.
 * @param method - El método de la API a llamar (ej. "host.get").
 * @param params - Los parámetros para el método de la API.
 * @returns El resultado de la llamada a la API.
 * @throws Un error si la llamada a la API falla.
 */
export async function callZabbixAPI(method: string, params: any): Promise<any> {
  const url = process.env.ZABBIX_URL;
  const token = process.env.ZABBIX_TOKEN;

  if (!url || !token) {
    throw new Error('Zabbix URL or Token is not configured in environment variables.');
  }

  const requestBody: ZabbixRequest = {
    jsonrpc: '2.0',
    method,
    params,
    auth: token,
    id: 1,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json-rpc',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Zabbix API request failed with status: ${response.status}`);
    }

    const data: ZabbixResponse = await response.json();

    if (data.error) {
      throw new Error(`Zabbix API Error: ${data.error.message} - ${data.error.data}`);
    }

    return data.result;
  } catch (error: any) {
    console.error('Error calling Zabbix API:', error);
    throw new Error(`Failed to call Zabbix API method "${method}": ${error.message}`);
  }
}
