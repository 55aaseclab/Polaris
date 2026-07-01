FROM node:22

RUN npm install -g serve@14

WORKDIR /opt/paseo

COPY apps/paseo/dist-build ./dist

EXPOSE 8082

CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:8082"]
