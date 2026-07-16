# PDF Transcriber Demo

Source files for the PDF transcriber Knative function. This is the demo use
case for the TP: upload a PDF, get back AI-transcribed text.

## Files

- `Function.java` - Quarkus JAX-RS handler. Serves the SPA on `GET /` and
  accepts PDF uploads on `POST /upload`. Calls Claude on Vertex AI via the
  Anthropic Java SDK.
- `index.html` - Standalone copy of the SPA embedded in `Function.java`.
  Useful for previewing the UI without running the backend.
- `pom.xml` - Modified Maven config (quarkus-rest, Anthropic SDK, Java 17).
- `application.properties` - Quarkus config (timeout, body size).


## AI prompting

The function calls Claude via the Anthropic Java SDK using Google Cloud
Vertex AI as the backend. It requires a GCP project with the Claude API
enabled (currently `itpc-gcp-hcm-pe-eng-claude` in region `us-east5`).
For gcloud auth Application Default Credentials (ADC) are used.

The PDF is sent as a base64-encoded document block to Claude along with
this instruction:

> Transcribe this PDF document. Return the complete text content, preserving
> the original structure and formatting as much as possible.

The model (Claude Sonnet 4.5) is configured with a 64,000 token output limit
and a 5-minute timeout. These can be adjusted in `Function.java`.

## Getting started

- **Deploy to a cluster**: run `/deploy-demo` in Claude Code (full e2e: prerequisites, cluster login, scaffold, operators, deploy)
- [Local development](steps-local.md)
