# firebase-admin 14.5+ y @google-cloud/firestore 9 piden Node 22 (con Node 20
# npm se salta Firestore en silencio y el servicio no arranca).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Las fechas y el horario de la tienda se calculan en hora de RD.
ENV TZ=America/Santo_Domingo
EXPOSE 8080

CMD ["node", "index.js"]
