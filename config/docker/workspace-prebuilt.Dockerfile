FROM debian:13

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.local/polaris/bin:/root/.cargo/bin:${PATH}

COPY config/docker/base-tools /tmp/polaris-base-tools

RUN bash /tmp/polaris-base-tools/install-base-tools.sh \
  && rm -rf /tmp/polaris-base-tools
