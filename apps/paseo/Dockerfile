FROM node:22

ARG PASEO_GIT_URL=https://github.com/cyruscyliu/paseo.git
ARG PASEO_GIT_REF=3d6b4adc68dc426789974e7c0bbad9d783a34c1f
ARG PASEO_WEB_BASE_URL=/paseo

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g serve@14

WORKDIR /opt

COPY patches /tmp/paseo-patches

RUN git clone "${PASEO_GIT_URL}" paseo \
  && cd paseo \
  && git checkout "${PASEO_GIT_REF}" \
  && git apply /tmp/paseo-patches/paseo-web-base-url.patch /tmp/paseo-patches/paseo-web-registry-scope.patch /tmp/paseo-patches/paseo-web-defaults.patch /tmp/paseo-patches/paseo-web-offer-link.patch

WORKDIR /opt/paseo

ENV PASEO_WEB_BASE_URL=${PASEO_WEB_BASE_URL}

RUN npm install \
  && npm run build:web --workspace=@getpaseo/app \
  && base_url="${PASEO_WEB_BASE_URL%/}" \
  && if [ -n "$base_url" ]; then \
    sed -i "s#href=\"/manifest.json\"#href=\"${base_url}/manifest.json\"#" /opt/paseo/packages/app/dist/index.html; \
    sed -i "s#\"id\": \"/\"#\"id\": \"${base_url}/\"#" /opt/paseo/packages/app/dist/manifest.json; \
    sed -i "s#\"start_url\": \"/\"#\"start_url\": \"${base_url}/\"#" /opt/paseo/packages/app/dist/manifest.json; \
    sed -i "s#\"scope\": \"/\"#\"scope\": \"${base_url}/\"#" /opt/paseo/packages/app/dist/manifest.json; \
    sed -i "s#\"src\": \"/#\"src\": \"${base_url}/#g" /opt/paseo/packages/app/dist/manifest.json; \
  fi

WORKDIR /opt/paseo/packages/app

EXPOSE 8082

CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:8082"]
