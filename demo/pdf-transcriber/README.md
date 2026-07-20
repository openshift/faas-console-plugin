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


## AI Authentication

The function authenticates to Google Cloud Vertex AI using Application
Default Credentials (ADC). No Anthropic API key is needed.

- **Local dev**: `gcloud auth application-default login` writes a credentials
  file to `~/.config/gcloud/application_default_credentials.json`. The SDK
  picks it up automatically via `GoogleCredentials.getApplicationDefault()`.
- **Cluster**: the ADC file is mounted as a Kubernetes secret (`gcp-adc`)
  at `/var/secrets/google/`, and `GOOGLE_APPLICATION_CREDENTIALS` points
  the SDK to it.

Two environment variables configure the Vertex AI endpoint:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP project with Claude API enabled |
| `CLOUD_ML_REGION` | Vertex AI region |

Copy `.env.example` to `.env` and fill in your values:

```sh
cp .env.example .env
```

The `/pdf-transcription-demo` skill loads these automatically and applies
them to the cluster via `func.yaml` run envs. The `.env` file is
gitignored.

## AI Prompting

The function uses the Anthropic Java SDK (`AnthropicOkHttpClient`) with the
`VertexBackend`. On upload, it:

1. Reads the PDF bytes and base64-encodes them.
2. Sends a single message to Claude with two content blocks:
   - A `DocumentBlockParam` containing the base64 PDF as a `Base64PdfSource`
   - A `TextBlockParam` with the instruction text
3. Streams the response text blocks into a single transcript string.

The instruction sent to the model:

> Transcribe this PDF document. Return the complete text content, preserving
> the original structure and formatting as much as possible.

Configuration (adjustable in `Function.java`):

| Setting | Value |
|---|---|
| Model | Claude Sonnet 4.5 (`Model.CLAUDE_SONNET_4_5`) |
| Max output tokens | 64,000 |
| Timeout | 5 minutes |

## Getting started

- **Deploy to a cluster**: run `/pdf-transcription-demo` in Claude Code (full e2e: prerequisites, cluster login, scaffold, operators, deploy)

