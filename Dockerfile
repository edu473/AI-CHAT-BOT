# Usa una imagen base de Node.js
FROM node:20-slim

# Establece el directorio de trabajo
WORKDIR /app

# Instala pnpm
RUN npm install -g pnpm

# Copia los archivos de dependencias
COPY package.json pnpm-lock.yaml ./

# Instala las dependencias del proyecto
RUN pnpm install --frozen-lockfile

# Copia el resto del código de la aplicación
COPY . .

# Construye la aplicación Next.js
RUN pnpm build

# Expone el puerto que usa la aplicación
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["pnpm", "start"]