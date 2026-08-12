FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-22:latest@sha256:0e4e66a6fa295e7d7c13c94d1b4f39cb058a97843ac01e555e72721ac31eefa8 AS nodebuilder
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

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.5-1786495588@sha256:32fa030f9ee19f8ab38df8233f217c7f5d666dfa564c015dd7deeeaf57c2719e AS gobuilder
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
