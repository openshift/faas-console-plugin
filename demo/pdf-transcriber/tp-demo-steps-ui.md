# PDF Transcriber Demo: Console UI Walkthrough

This guide walks through deploying the PDF Transcriber function entirely through the OpenShift Console UI. No CLI commands are used during the demo itself.

## Prerequisites

Before starting:

- OpenShift 4.22+ cluster with OpenShift Serverless and the FaaS Console Plugin installed (see [Quick Install via Operator](https://github.com/openshift/faas-console-plugin#quick-install-via-operator))
- `oc` CLI logged into the cluster (`oc login`)
- GitHub Personal Access Token (classic) with the `repo` and `workflow` scopes. The `workflow` scope is required because the function repository includes a GitHub Actions workflow file. Adding the `delete_repo` scope is recommended, so the Console can remove the repository again if function creation fails (see [Troubleshooting](#troubleshooting)).
- GCP Application Default Credentials JSON file. Generate it with `gcloud auth application-default login` (requires the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), e.g. `brew install google-cloud-sdk` on macOS). The SDK writes the file to `~/.config/gcloud/application_default_credentials.json`.
- Values for GCP authorization:
  - `ANTHROPIC_VERTEX_PROJECT_ID` (GCP project with Vertex AI / Claude access)
  - `CLOUD_ML_REGION` (e.g. `us-east5`)

> **Note on Console perspectives:** Since OpenShift 4.19 the Console shows a single unified view (labeled **Core platform** at the top of the sidebar), and the **Developer** perspective is disabled by default. This walkthrough works in the default view. If a cluster admin has enabled the Developer perspective, a perspective switcher appears at the top of the sidebar instead, and **FaaS** is also available in the Developer perspective sidebar.

---

## Step 1: Create a Namespace

1. Open the OpenShift Console.

2. Make sure you are in the **Core platform** view (the default). If the sidebar shows a perspective switcher, select **Core platform**.

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
   - **Value:** Click **Browse...** and upload your `~/.config/gcloud/application_default_credentials.json` file

4. Click **Create**. The secret detail page confirms creation.

---

## Step 3: Connect GitHub

1. Navigate to **Workloads > FaaS** in the sidebar (the last item in the **Workloads** section). If you use the Developer perspective, click **FaaS** in its sidebar instead.

2. The **Functions** page opens. If GitHub is not yet connected, the **Connect to GitHub** dialog opens automatically. (If you closed it, click **Connect to GitHub** in the top-right corner.)

3. Enter your GitHub Personal Access Token in the **Personal Access Token** field and click **Connect**.

4. After connecting, your GitHub avatar and login appear in the top-right corner (its menu offers **Go to GitHub** and **Disconnect**), and the **Create function** button is enabled.

---

## Step 4: Create the Function

1. Click **Create function** (or **Create new function** if functions already exist).

2. Fill in the basic fields:
   - **Owner:** pre-filled with your GitHub login (read-only)
   - **Repository:** `pdf-transcriber-demo`
   - **Branch:** `main`
   - **Name:** `pdf-transcriber-demo`
   - **Language:** Quarkus
   - **Registry:** pre-filled with the cluster's internal image registry and the namespace (read-only)
   - **Namespace:** `pdf-transcriber`

   Type the namespace exactly, without leading or trailing spaces. The **Secret** dropdown in the next step only lists secrets from the namespace entered here.

3. Add environment variables. Click **Add environment variable** once. This shows three groups: plain environment variables, **Secrets**, and **ConfigMaps**. Each group has its own **Add key/value** button for additional rows.

   **Plain environment variables** (use the **Add key/value** button below this group for the second row):
   - Name: `ANTHROPIC_VERTEX_PROJECT_ID`, Value: your GCP project ID
   - Name: `CLOUD_ML_REGION`, Value: your GCP region (e.g. `us-east5`)

   **Secrets** group:
   - Name: `GCP_CREDENTIALS`, Secret: `gcp-adc`, Key: `application_default_credentials.json`

   This injects the JSON content of the secret directly into the `GCP_CREDENTIALS` environment variable at runtime. Leave the **ConfigMaps** group empty.

4. Click **Create**. The function is created and appears in the functions list with status **Not deployed**.

   Creating the function also creates a **public** GitHub repository `<your-login>/pdf-transcriber-demo` with the scaffolded Quarkus project, and starts a first GitHub Actions workflow run that builds and deploys the scaffolded function. While a workflow run is in progress, a spinning icon (tooltip: *Workflow run in progress*) is shown next to the status. After this first run finishes, the status changes to **Running**.

---

## Step 5: Edit Function Code

1. Click the **Edit** (pencil) icon on the `pdf-transcriber-demo` row.

2. The editor loads showing the scaffolded Function.java and file tree.

3. Replace three files with the PDF transcriber implementation. Open the source files from this repository's `demo/pdf-transcriber/` directory in a local editor, copy their contents, then paste into the Console editor. For each file, click it in the file tree, select all, and paste the replacement content:

   - **`src/main/java/functions/Function.java`** -- the function handler (Anthropic SDK imports, `GCP_CREDENTIALS` env var via `GoogleCredentials.fromStream()`, `POST /upload` endpoint, embedded SPA HTML)
   - **`pom.xml`** -- adds Anthropic Java SDK and Vertex backend dependencies
   - **`src/main/resources/application.properties`** -- sets read timeout, max body size, and health endpoint config

   All three files must be replaced. The scaffolded `pom.xml` does not include the Anthropic SDK dependencies, so the build will fail if only `Function.java` is replaced.

4. Replace the scaffolded test files to prevent compilation errors. Click each file in the file tree, select all, and paste the replacement content:

   - **`src/test/java/functions/FunctionTest.java`** -- replace with:
     ```java
     package functions;

     import org.junit.jupiter.api.Test;

     class FunctionTest {
         @Test
         void placeholder() {
         }
     }
     ```
   - **`src/test/java/functions/NativeFunctionIT.java`** -- replace with:
     ```java
     package functions;

     class NativeFunctionIT extends FunctionTest {
     }
     ```

   The scaffolded tests reference `Input` and `Output` classes that no longer exist after replacing `Function.java`, so the build will fail if these are not updated.

   Each modified file is marked with a dot (●) in the file tree until it is saved.

5. Click **Save & Deploy**. A success banner appears: "Pushed to GitHub. Build and deploy workflow run initiated."

---

## Step 6: Verify Deployment

1. Click **Back to Functions** to return to the functions list.

2. The Console pushed your code to GitHub, and a new GitHub Actions workflow run builds the container image, pushes it to the cluster's internal registry, and deploys it. While the run is in progress, the spinning icon is shown next to the status. The status still shows **Running** during this time, because the scaffolded function from Step 4 keeps serving until the new version is deployed.

3. Wait for the spinning icon to disappear (this takes a few minutes). If the run fails, a warning icon (tooltip: *Latest workflow run failed*) is shown instead, and clicking it opens the failed run on GitHub.

4. The **URL** column shows a link named after the function's route (e.g. `pdf-transcriber-demo-pdf-transcriber`). Click it to open the PDF Transcriber web app in a new tab.

5. Upload a PDF file and click **Transcribe** to verify the function works end-to-end.

---

## Troubleshooting

**Creating the function in Step 4 fails and the form stays open:**
- Check the scopes of your GitHub PAT. Without the `workflow` scope, the Console creates the repository but cannot push the scaffolded project (it contains `.github/workflows/func-deploy.yaml`). The plugin backend logs `failed to push files ... create tree: ... 404 Not Found` (`oc logs -n openshift-operators deploy/console-functions-plugin`).
- Without the `delete_repo` scope, the Console cannot remove the partially created repository afterwards, and creating the function again fails because the repository name is taken. Delete the repository on GitHub, then connect a PAT with the `repo` and `workflow` scopes (avatar menu > **Disconnect**, then **Connect to GitHub**) and try again.

**The Secret dropdown in Step 4 is empty:**
- Check the **Namespace** field: it must be exactly `pdf-transcriber`, without leading or trailing spaces. The **Registry** field shows the namespace it uses.
- Make sure you are using the **Secret** dropdown in the **Secrets** group, not the **ConfigMap** dropdown in the **ConfigMaps** group.

**Where to watch the build:**
- The build runs in GitHub Actions, not on the cluster, so it does not appear under **Builds** in the Console. Open the function in the editor, click the **Repository** link, and open the **Actions** tab on GitHub.

**Function stays in Not deployed:**
- Check the GitHub Actions tab on the function's repo for workflow run status
- Check operator health: ensure Serverless CSV shows "Succeeded" (`oc get csv -A | grep serverless`)

**Build fails with compilation errors:**
- Verify that all three files were replaced in Step 5 (`Function.java`, `pom.xml`, `application.properties`). The scaffolded `pom.xml` does not include the Anthropic SDK dependencies.

**GCP_CREDENTIALS not working:**
- Verify the secret `gcp-adc` exists in the `pdf-transcriber` namespace
- Verify the key name matches exactly: `application_default_credentials.json`
- Ensure the ADC JSON file was generated with `gcloud auth application-default login`

**Function returns 500 errors:**
- Check that `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` are set correctly
- Verify your GCP project has Vertex AI API enabled and Claude model access
