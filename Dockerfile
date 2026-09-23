FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-24:latest@sha256:080963f585bfb0440880601df9b76e24a4e8b5e2ff5343faa0084ccd3363e330 AS nodebuilder
USER root

WORKDIR /usr/src/app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && CYPRESS_INSTALL_BINARY=0 node ./.yarn/releases/yarn-4.18.0.cjs install --immutable

COPY console-extensions.json tsconfig.json webpack.config.mts ./
COPY src/ src/
COPY locales/ locales/
COPY config/ config/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && node ./.yarn/releases/yarn-4.18.0.cjs build

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.26.7-1789950433@sha256:15c3098dc4639e8a0e6a1bc77b50964513a1d76dccae4b07b9808101c5addd04 AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
WORKDIR /opt/app-root/src

COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    go -C backend mod download

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    mkdir -p bin && CGO_ENABLED=0 go -C backend build -ldflags="-s -w" -o ../bin/plugin-backend .

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:7a0454cbd9bd847e8f6a63b6f0254a6efbeb6e0ed71a5d824a4f6cccbe626650
COPY --from=gobuilder /opt/app-root/src/bin/plugin-backend /usr/bin/plugin-backend
COPY --from=gobuilder /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
USER 1001

LABEL name="openshift-serverless-tech-preview/functions-console-plugin-rhel9" \
      com.redhat.component="openshift-serverless-faas-console-plugin-container" \
      version="2.0" \
      release="1" \
      summary="OpenShift Serverless Functions Console Plugin" \
      description="A Functions-as-a-Service UI for the OpenShift Web Console" \
      io.k8s.display-name="OpenShift Serverless Functions Console Plugin" \
      io.k8s.description="A Functions-as-a-Service UI for the OpenShift Web Console" \
      io.openshift.tags="openshift,serverless,functions,faas,console,plugin" \
      maintainer="serverless-support@redhat.com" \
      cpe="cpe:/a:redhat:openshift_serverless:2.0::el9"

ENTRYPOINT ["plugin-backend"]
