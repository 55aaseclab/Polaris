FROM node:22

RUN npm install -g serve@14

WORKDIR /opt/paseo

COPY apps/paseo/dist-build ./dist

RUN rm -rf dist/paseo \
  && mkdir -p dist/paseo \
  && ln -s ../_expo dist/paseo/_expo \
  && ln -s ../assets dist/paseo/assets \
  && ln -s ../index.html dist/paseo/index.html \
  && ln -s ../manifest.json dist/paseo/manifest.json \
  && ln -s ../metadata.json dist/paseo/metadata.json \
  && ln -s ../favicon.ico dist/paseo/favicon.ico \
  && ln -s ../apple-touch-icon.png dist/paseo/apple-touch-icon.png \
  && ln -s ../pwa-icon-192.png dist/paseo/pwa-icon-192.png \
  && ln -s ../pwa-icon-512.png dist/paseo/pwa-icon-512.png \
  && ln -s ../robots.txt dist/paseo/robots.txt

EXPOSE 8082

CMD ["serve", "-s", "dist", "-l", "tcp://0.0.0.0:8082"]
