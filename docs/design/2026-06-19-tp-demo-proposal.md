# TP Demo Proposal: Function Creation with PDF Transcription

**Date:** 2026-06-19
**Status:** Draft, for PM review
**Related:** [OCPSTRAT-2942](https://redhat.atlassian.net/browse/OCPSTRAT-2942)

---

## Use Case

A developer creates, deploys, and invokes a PDF transcription function through the OpenShift Console. An end user opens the function's URL, uploads a PDF, and receives the transcribed text.

## Prerequisites

| Prerequisite | Notes |
|---|---|
| GitHub account | Connected to Github with PAT authentication (OAuth nice-to-have) |
| Anthropic API token | Pre-created |
| Functions Operator | Installed with Console plugin enabled |
| Knative Serving | Installed and configured (KEDA nice-to-have) |

## Demo Flow

### Part 1: Create the Function in Console

**Must-have flow:**

1. Open FaaS in the OpenShift Console
2. Create a new function:
   - Name: pdf-transcriber
   - Runtime: java, python, or node
   - Secret reference: link the Anthropic API key secret
3. Redirect to the functions overview, function appears with deployment in progress
4. Click Edit on the new function
5. Copy/paste the pdf-transcriber code
6. Save & Deploy, redirect to the functions overview
7. Function deployment runs
8. Function status updates to "Running" and shows URL

**Nice-to-have flow (with template repo support):**

1. Open FaaS in the OpenShift Console
2. Create a new function:
   - Name: pdf-transcriber
   - Runtime: java, python, or node
   - Secret reference: link the Anthropic API key secret
   - Select template from a template repository (e.g. pdf-transcriber from the internal templates repo)
3. Redirect to the functions overview, function appears with deployment in progress
4. Function deployment runs
5. Function status updates to "Running" and shows URL

### Part 2: Invoke the Function

1. Click the function's URL in the list page
2. SPA loads in the browser with an upload field
3. Upload a PDF
4. Loading indicator while Anthropic transcribes
5. Transcript appears in the content area
6. Copy transcript to clipboard

## Request Flow

The function serves both a frontend SPA and the transcription logic.

```
User Browser
    |
    v
OCP Route (https://pdf-transcriber.<cluster-domain>)
    |
    v
Function Pod
    |-- GET /         -> serves static SPA (upload field and button + content area + copy button)
    |-- POST /upload  -> receives PDF, calls Anthropic API, returns transcript
    |
    |-- Anthropic API key read from K8s Secret (mounted via func.yaml envs)
    |-- PDF held in pod memory or persisted in local storage during processing (ephemeral)
    |-- Synchronous Anthropic API call (up to 5 min timeout) and return
```

## New Features to Build

0. **Codebase cleanup and dev environment updates**: resolve PoC tech debt, fix known bugs, update development tooling (tracked under [SRVOCF-810](https://redhat.atlassian.net/browse/SRVOCF-810))
1. **Secret reference UI**: add minimal env/secret config to Create page
2. **PDF transcriber function code**: build and verify locally
  a.  **Copy-paste into Console editor**: verify the demo works end-to-end via the existing Console plugin
3. \[Nice-to-have\] **Create file in editor**: allow creating new files in the tree view
4. \[Nice-to-have\] **Template repo support**: pre-package the function as a selectable template

---

## What Needs to Be Built

### 1. Console: Secret Reference Support in Create UI

Currently the Create form has no way to configure environment variables from K8s Secrets. Minimum viable for the demo:

- A section in the Create page to add secret references
- User enters: env var name, K8s secret name, secret key
- Written to func.yaml under `envs` field
- Must-have: one secret, nice-to-have: multiple secrets
- The func CLI processes this during `func deploy`

### 2. PDF Transcriber Function Code

A self-contained function that:

- Serves a static HTML/CSS/JS SPA on `GET /` (SPA HTML embedded as a template string in the handler code, no separate file)
- Accepts PDF upload on `POST /upload`
- Reads `ANTHROPIC_API_KEY` from environment (sourced from K8s Secret via func.yaml)
- Sends PDF to Anthropic API for transcription
- Returns transcript as response

**Approach:** Build and test locally first, then deploy via Console.

### 3. Console: Add "Create File" to Editor (Nice-to-Have)

Currently the editor only shows and edits files that already exist in the repo. Adding the ability to create new files in the tree view would allow separating the SPA into its own `index.html` file instead of embedding it in the handler code.

### 4. Template Repo (Nice-to-Have)

Add template repository support ([SRVOCF-863](https://redhat.atlassian.net/browse/SRVOCF-863)):

- Pre-build a `pdf-transcriber` template in the [functions-dev/templates](https://github.com/functions-dev/templates) repo
- During creation, select the template instead of writing code manually

## Open Questions

1. **func.yaml secret references:** Does `func deploy` correctly process `envs` secret references, will we have access to secret in form of a environment variable from the function body?
2. **Request timeout:** The synchronous Anthropic API call may take over a minute. Default request timeout and idle timeout need to be configured to avoid issues.
3. **PDF size limits:** Need to define a reasonable max PDF size for the demo (e.g. 10 MB).
