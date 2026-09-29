FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node","server.js"]
