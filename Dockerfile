FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-22:latest@sha256:4c269ae74789f65e26bbb3ce345dba31e53dad3a74f0619774ac4e43dd754752 AS nodebuilder
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

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.5-1785791459@sha256:46376c6723c3a4961a165c2768461e7fac48a79932cdde0a6e6a57724ef61ba0 AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
WORKDIR /opt/app-root/src

COPY --chown=1001:0 Makefile ./
COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN make install-backend

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN make build-backend

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:b1e86b97028b8fcfb6d85f997c39e6b6b67496163ef8d80d243220a4918e8bef
COPY --from=gobuilder /opt/app-root/src/bin/plugin-backend /usr/bin/plugin-backend
COPY --from=gobuilder /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
USER 1001

ENTRYPOINT ["plugin-backend"]
