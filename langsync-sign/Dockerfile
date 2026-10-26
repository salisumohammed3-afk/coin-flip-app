FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
