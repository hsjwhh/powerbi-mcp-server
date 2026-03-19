FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY .env.example ./.env.example
COPY README.md ./README.md
COPY API.md ./API.md
COPY CHANGELOG.md ./CHANGELOG.md

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
