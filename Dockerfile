FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-22:latest@sha256:2c3bb588fae7d9d1e5acd1afd77a61cc8cbae2d0d3f85bb7ec03bb3275ba2420 AS nodebuilder
USER root
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm i -g corepack && corepack enable

WORKDIR /usr/src/app

COPY Makefile package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN make install-frontend

COPY console-extensions.json tsconfig.json webpack.config.ts ./
COPY src/ src/
COPY locales/ locales/
COPY config/ config/
COPY testing/ testing/
RUN make build-frontend

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.5-1786351949@sha256:0b471eb04868f3d9d90bf3c668f9c6c7a22cef07474ac9fec067909dfd7dec7c AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
WORKDIR /opt/app-root/src

COPY --chown=1001:0 Makefile ./
COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN make install-backend

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN make build-backend

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:7e7f79ab747bf2b452e3043dd89f388e92be4c7fdcc8b815b58adf6c99c39c95
COPY --from=gobuilder /opt/app-root/src/bin/plugin-backend /usr/bin/plugin-backend
COPY --from=gobuilder /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
USER 1001

ENTRYPOINT ["plugin-backend"]
