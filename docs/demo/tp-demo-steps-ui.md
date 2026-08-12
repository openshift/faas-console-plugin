# PDF Transcriber Demo: Console UI Walkthrough

This guide walks through deploying the PDF Transcriber function entirely through the OpenShift Console UI. No CLI commands are used during the demo itself.

## Prerequisites

Before starting:

- OpenShift cluster with the following operators installed and healthy: 
  - OpenShift Serverless (KnativeServing configured)
  - OpenShift Pipelines
- FaaS Console Plugin installed and enabled
- GitHub Personal Access Token (PAT) with `repo` scope
- GCP Application Default Credentials JSON file (`~/.config/gcloud/application_default_credentials.json`)
- Values from `demo/pdf-transcriber/.env`:
  - `ANTHROPIC_VERTEX_PROJECT_ID` (GCP project with Vertex AI / Claude access)
  - `CLOUD_ML_REGION` (e.g. `us-east5`)

## Code Change: Env-var-based credentials

The `demo/pdf-transcriber/Function.java` has been modified to read GCP credentials from the `GCP_CREDENTIALS` environment variable directly (as JSON content), instead of requiring a volume-mounted file. This means the entire deployment can be configured through the Create Function form's env var and secret reference fields, with no volume mounts needed.

---

## Step 1: Create a Namespace

1. Open the OpenShift Console.

2. Switch to the **Core platform** perspective using the perspective switcher in the sidebar.

3. Navigate to **Home > Projects** and click **Create Project**.

4. Enter `pdf-transcriber` as the project name and click **Create**.

5. The project is created and you are taken to the project details page.

---

## Step 2: Create the GCP Credentials Secret

1. With the `pdf-transcriber` project selected, navigate to **Workloads > Secrets** in the sidebar.

2. Click the **Create** dropdown and select **Key/value secret**.

3. Fill in the form:
   - **Secret name:** `gcp-adc`
   - **Key:** `application_default_credentials.json`
   - **Value:** Click **Browse** and upload your `~/.config/gcloud/application_default_credentials.json` file

4. Click **Create**. The secret detail page confirms creation.

---

## Step 3: Connect GitHub

1. Switch to the **Developer** perspective.

2. Click **FaaS** in the sidebar.

3. If GitHub is not yet connected, click the user avatar button and enter your GitHub Personal Access Token.

4. After connecting, you will see the Functions list page.

---

## Step 4: Create the Function

1. Click **Create new function**.

2. Fill in the basic fields:
   - **Repository:** `pdf-transcriber-demo`
   - **Branch:** `main`
   - **Name:** `pdf-transcriber-demo`
   - **Language:** Quarkus
   - **Namespace:** `pdf-transcriber`

3. Add environment variables. Click "Add environment variable" for each:

   **Plain key/value env vars:**
   - Name: `ANTHROPIC_VERTEX_PROJECT_ID`, Value: your GCP project ID
   - Name: `CLOUD_ML_REGION`, Value: your GCP region (e.g. `us-east5`)

   **Secret reference env var:**
   - Name: `GCP_CREDENTIALS`, Secret: `gcp-adc`, Key: `application_default_credentials.json`

   This injects the JSON content of the secret directly into the `GCP_CREDENTIALS` environment variable at runtime.

4. Click **Create**. The function is created and appears in the functions list.

---

## Step 5: Edit Function Code

1. Click the **Edit** (pencil) icon on the `pdf-transcriber-demo` row.

2. The editor loads showing the scaffolded Function.java and file tree.

3. Replace three files with the PDF transcriber implementation from `demo/pdf-transcriber/`. For each file, click it in the file tree, select all, and paste the replacement content:

   - **`src/main/java/functions/Function.java`** -- the function handler (Anthropic SDK imports, `GCP_CREDENTIALS` env var via `GoogleCredentials.fromStream()`, `POST /upload` endpoint, embedded SPA HTML)
   - **`pom.xml`** -- adds Anthropic Java SDK and Vertex backend dependencies
   - **`src/main/resources/application.properties`** -- sets read timeout, max body size, and health endpoint config

   All three files must be replaced. The scaffolded `pom.xml` does not include the Anthropic SDK dependencies, so the build will fail if only `Function.java` is replaced.

4. Click **Save & Deploy**. A success banner appears: "Pushed to GitHub. Deployment running..."

---

## Step 6: Verify Deployment

1. Click **Back to Functions** to return to the functions list.

2. The function initially shows "NotDeployed" status. The deployment runs via Tekton on the cluster (the Console pushes code to GitHub, and a Tekton pipeline on the cluster builds and deploys the container image).

3. Wait for the status to change to **Running** (this can take several minutes for the first build, as Tekton needs to pull base images and compile the Quarkus application).

4. Once running, a **URL** column will show the function's route. Click it to open the PDF Transcriber web app.

5. Upload a PDF file and click **Transcribe** to verify the function works end-to-end.

---

## Troubleshooting

**Function stays in NotDeployed:**
- Check the Builds page in the Developer perspective for pipeline run status
- Ensure the `pipeline` ServiceAccount exists in the namespace (created by Pipelines operator)
- Check operator health: ensure Serverless and Pipelines CSVs show "Succeeded"

**Build fails with compilation errors:**
- Verify that all three files were replaced in Step 5 (`Function.java`, `pom.xml`, `application.properties`). The scaffolded `pom.xml` does not include the Anthropic SDK dependencies.

**GCP_CREDENTIALS not working:**
- Verify the secret `gcp-adc` exists in the `pdf-transcriber` namespace
- Verify the key name matches exactly: `application_default_credentials.json`
- Ensure the ADC JSON file was generated with `gcloud auth application-default login`

**Function returns 500 errors:**
- Check that `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` are set correctly
- Verify your GCP project has Vertex AI API enabled and Claude model access
