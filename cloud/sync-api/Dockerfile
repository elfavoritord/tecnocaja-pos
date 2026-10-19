# firebase-admin 14.5+ y @google-cloud/firestore 9 piden Node 22 (igual que
# cloud/tienda-online).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "index.js"]
