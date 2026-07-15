FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

COPY prisma ./prisma

RUN npm ci

RUN npx prisma generate

COPY src ./src

EXPOSE 8080

CMD ["npm", "start"]