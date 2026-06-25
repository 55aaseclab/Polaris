FROM node:22

ARG PASEO_GIT_URL=https://github.com/cyruscyliu/paseo.git
ARG PASEO_GIT_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g serve@14

WORKDIR /opt

RUN git clone "${PASEO_GIT_URL}" paseo \
  && cd paseo \
  && git checkout "${PASEO_GIT_REF}"

WORKDIR /opt/paseo

RUN npm install \
  && npm run build:web --workspace=@getpaseo/app

WORKDIR /opt/paseo/packages/app

EXPOSE 8082

CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:8082"]
