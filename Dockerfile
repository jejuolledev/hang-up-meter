FROM node:24-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.mjs", "--host", "0.0.0.0"]
