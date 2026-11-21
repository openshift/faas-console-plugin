FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/nodejs-24:latest@sha256:5788fc5170268cf54cde8f781e9aa98068e6c996dec2b48882bf4086e7c95f92 AS nodebuilder
USER root

WORKDIR /usr/src/app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node .yarn/releases/yarn-*.cjs install --immutable

COPY console-extensions.json tsconfig.json webpack.config.mts ./
COPY src/ src/
COPY locales/ locales/
COPY config/ config/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && node .yarn/releases/yarn-*.cjs build

FROM --platform=$BUILDPLATFORM registry.access.redhat.com/ubi9/go-toolset:1.27.3-1795042432@sha256:51eef2836e5223c41577757c30544fbfb3f0710f3436b70b82d2195e35fcb743 AS gobuilder
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH
ENV GOFIPS140=v1.0.0
WORKDIR /opt/app-root/src

COPY --chown=1001:0 backend/go.mod backend/go.sum backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    go -C backend mod download

COPY --chown=1001:0 --from=nodebuilder /usr/src/app/dist backend/static
COPY --chown=1001:0 backend/ backend/
RUN if [ -f /cachi2/cachi2.env ]; then . /cachi2/cachi2.env; fi && \
    mkdir -p bin && CGO_ENABLED=0 go -C backend build -ldflags="-s -w" -o ../bin/plugin-backend .

FROM registry.access.redhat.com/ubi9-micro:latest@sha256:dbd325b96bcd432dd42816d31412bdf1dc0fb973b79ed310344bc23c76c068db
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
