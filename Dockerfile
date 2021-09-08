FROM node:alpine

WORKDIR /app
COPY . .
RUN npm i --production

CMD node .
