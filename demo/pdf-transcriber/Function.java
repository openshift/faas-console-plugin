// PDF Transcriber Function Handler (Quarkus / JAX-RS)
//
// Serves a SPA on GET / where users upload a PDF.
// POST /upload sends the PDF to Claude on Vertex AI and returns the transcript.
//
// See pdf-transcriber/README.md for setup instructions.

package functions;

import com.anthropic.vertex.backends.VertexBackend;
import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.models.messages.Base64PdfSource;
import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.DocumentBlockParam;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.Model;
import com.anthropic.models.messages.TextBlockParam;

import jakarta.annotation.PostConstruct;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import org.jboss.resteasy.reactive.RestForm;
import org.jboss.resteasy.reactive.multipart.FileUpload;

import com.google.auth.oauth2.GoogleCredentials;

import java.nio.file.Files;
import java.time.Duration;
import java.util.Base64;
import java.util.List;

@Path("/")
@ApplicationScoped
public class Function {

    private AnthropicClient client;

    @PostConstruct
    void init() {
        String projectId = System.getenv("ANTHROPIC_VERTEX_PROJECT_ID");
        String region = System.getenv("CLOUD_ML_REGION");
        if (region == null) {
            region = "us-east5";
        }

        try {
            client = AnthropicOkHttpClient.builder()
                .backend(VertexBackend.builder()
                    .project(projectId)
                    .region(region)
                    .googleCredentials(GoogleCredentials.getApplicationDefault())
                    .build())
                .timeout(Duration.ofMinutes(5))
                .build();
        } catch (java.io.IOException e) {
            throw new RuntimeException("Failed to load Google credentials", e);
        }
    }

    @GET
    @Produces(MediaType.TEXT_HTML)
    public String index() {
        return SPA_HTML;
    }

    @POST
    @Path("upload")
    @Consumes(MediaType.MULTIPART_FORM_DATA)
    @Produces(MediaType.TEXT_PLAIN)
    public Response upload(@RestForm("file") FileUpload file) {
        if (file == null || file.uploadedFile() == null) {
            return Response.status(400).entity("No file uploaded").build();
        }

        try {
            byte[] pdfBytes = Files.readAllBytes(file.uploadedFile());
            String base64Pdf = Base64.getEncoder().encodeToString(pdfBytes);

            DocumentBlockParam doc = DocumentBlockParam.builder()
                .source(Base64PdfSource.builder().data(base64Pdf).build())
                .build();

            MessageCreateParams params = MessageCreateParams.builder()
                .model(Model.CLAUDE_SONNET_4_5)
                .maxTokens(64000L)
                .addUserMessageOfBlockParams(List.of(
                    ContentBlockParam.ofDocument(doc),
                    ContentBlockParam.ofText(TextBlockParam.builder()
                        .text("Transcribe this PDF document. "
                            + "Return the complete text content, preserving "
                            + "the original structure and formatting as much "
                            + "as possible.")
                        .build())))
                .build();

            Message response = client.messages().create(params);

            StringBuilder transcript = new StringBuilder();
            response.content().stream()
                .flatMap(block -> block.text().stream())
                .forEach(textBlock -> transcript.append(textBlock.text()));

            return Response.ok(transcript.toString()).build();

        } catch (Exception e) {
            return Response.status(500).entity(e.getMessage()).build();
        }
    }

    private static final String SPA_HTML = """
            <!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PDF Transcriber</title>
            <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }

              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #f5f5f5;
                color: #1a1a1a;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 3rem 1.5rem;
              }

              .container {
                width: 100%;
                max-width: 640px;
              }

              h1 {
                font-size: 1.5rem;
                font-weight: 600;
                margin-bottom: 0.25rem;
              }

              .subtitle {
                font-size: 0.875rem;
                color: #6b6b6b;
                margin-bottom: 2rem;
              }

              .upload-area {
                border: 2px dashed #c8c8c8;
                border-radius: 8px;
                padding: 2.5rem 1.5rem;
                text-align: center;
                background: #fff;
                cursor: pointer;
                transition: border-color 0.15s, background 0.15s;
              }

              .upload-area:hover {
                border-color: #0066cc;
                background: #f0f6ff;
              }

              .upload-area.has-file {
                border-style: solid;
                border-color: #0066cc;
                background: #f0f6ff;
                padding: 1.25rem 1.5rem;
              }

              .upload-area.drag-over {
                border-color: #0066cc;
                background: #f0f6ff;
              }

              .upload-icon {
                font-size: 2rem;
                margin-bottom: 0.75rem;
                color: #6b6b6b;
              }

              .upload-area.has-file .upload-icon {
                font-size: 1.25rem;
                margin-bottom: 0;
                color: #0066cc;
              }

              .upload-text {
                font-size: 0.9375rem;
                color: #6b6b6b;
              }

              .upload-text strong {
                color: #0066cc;
              }

              .upload-area.has-file .upload-text {
                font-size: 0.875rem;
                color: #1a1a1a;
              }

              .upload-hint {
                font-size: 0.75rem;
                color: #999;
                margin-top: 0.5rem;
              }

              .file-row {
                display: flex;
                align-items: center;
                gap: 0.75rem;
              }

              .file-name {
                flex: 1;
                text-align: left;
                font-weight: 500;
              }

              .file-clear {
                font-size: 0.75rem;
                color: #6b6b6b;
                cursor: pointer;
                border: none;
                background: none;
                text-decoration: underline;
              }

              .file-clear:hover {
                color: #c00;
              }

              .transcribe-btn {
                display: block;
                width: 100%;
                margin-top: 1rem;
                padding: 0.75rem;
                font-size: 0.9375rem;
                font-weight: 500;
                color: #fff;
                background: #0066cc;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                transition: background 0.15s;
              }

              .transcribe-btn:hover:not(:disabled) {
                background: #0052a3;
              }

              .transcribe-btn:disabled {
                background: #c8c8c8;
                cursor: not-allowed;
              }

              .loading {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 0.75rem;
                margin-top: 2rem;
                padding: 1.5rem;
                background: #fff;
                border-radius: 8px;
                font-size: 0.875rem;
                color: #6b6b6b;
              }

              .spinner {
                width: 20px;
                height: 20px;
                border: 2px solid #e0e0e0;
                border-top-color: #0066cc;
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
              }

              @keyframes spin {
                to { transform: rotate(360deg); }
              }

              .result {
                margin-top: 2rem;
                background: #fff;
                border-radius: 8px;
                overflow: hidden;
              }

              .result-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0.75rem 1rem;
                border-bottom: 1px solid #e8e8e8;
              }

              .result-label {
                font-size: 0.8125rem;
                font-weight: 600;
                color: #6b6b6b;
                text-transform: uppercase;
                letter-spacing: 0.04em;
              }

              .copy-btn {
                font-size: 0.8125rem;
                color: #0066cc;
                background: none;
                border: 1px solid #0066cc;
                border-radius: 4px;
                padding: 0.25rem 0.75rem;
                cursor: pointer;
                transition: background 0.15s, color 0.15s;
              }

              .copy-btn:hover {
                background: #0066cc;
                color: #fff;
              }

              .result-content {
                padding: 1rem;
                font-size: 0.875rem;
                line-height: 1.6;
                color: #333;
                max-height: 400px;
                overflow-y: auto;
                white-space: pre-wrap;
              }

              .error {
                margin-top: 2rem;
                padding: 1rem;
                background: #fef2f2;
                border: 1px solid #fca5a5;
                border-radius: 8px;
                font-size: 0.875rem;
                color: #991b1b;
              }

              .hidden { display: none; }
            </style>
            </head>
            <body>

            <div class="container">
              <h1>PDF Transcriber</h1>
              <p class="subtitle">Upload a PDF to transcribe its contents using AI.</p>

              <div class="upload-area" id="uploadArea">
                <div id="emptyState">
                  <div class="upload-icon">&#128196;</div>
                  <p class="upload-text"><strong>Choose a PDF</strong> or drag it here</p>
                  <p class="upload-hint">PDF files only</p>
                </div>
                <div id="fileState" class="hidden">
                  <div class="file-row">
                    <span class="upload-icon">&#128196;</span>
                    <span class="upload-text file-name" id="fileName"></span>
                    <button class="file-clear" id="clearBtn" type="button">Remove</button>
                  </div>
                </div>
              </div>
              <input type="file" id="fileInput" accept=".pdf,application/pdf" hidden>
              <button class="transcribe-btn" id="transcribeBtn" disabled>Transcribe</button>

              <div class="loading hidden" id="loading">
                <div class="spinner"></div>
                Transcribing your PDF...
              </div>

              <div class="result hidden" id="result">
                <div class="result-header">
                  <span class="result-label">Transcript</span>
                  <button class="copy-btn" id="copyBtn">Copy</button>
                </div>
                <div class="result-content" id="resultContent"></div>
              </div>

              <div class="error hidden" id="error"></div>
            </div>

            <script>
              var uploadArea = document.getElementById('uploadArea');
              var fileInput = document.getElementById('fileInput');
              var emptyState = document.getElementById('emptyState');
              var fileState = document.getElementById('fileState');
              var fileName = document.getElementById('fileName');
              var clearBtn = document.getElementById('clearBtn');
              var transcribeBtn = document.getElementById('transcribeBtn');
              var loading = document.getElementById('loading');
              var result = document.getElementById('result');
              var resultContent = document.getElementById('resultContent');
              var copyBtn = document.getElementById('copyBtn');
              var error = document.getElementById('error');

              var selectedFile = null;

              function setFile(file) {
                if (!file) return;
                if (file.type !== 'application/pdf') {
                  showError('Please select a PDF file.');
                  return;
                }
                selectedFile = file;
                fileName.textContent = file.name;
                emptyState.classList.add('hidden');
                fileState.classList.remove('hidden');
                uploadArea.classList.add('has-file');
                transcribeBtn.disabled = false;
                hideError();
              }

              function clearFile() {
                selectedFile = null;
                fileInput.value = '';
                emptyState.classList.remove('hidden');
                fileState.classList.add('hidden');
                uploadArea.classList.remove('has-file');
                transcribeBtn.disabled = true;
              }

              function showError(msg) {
                error.textContent = msg;
                error.classList.remove('hidden');
              }

              function hideError() {
                error.classList.add('hidden');
              }

              function showLoading() {
                loading.classList.remove('hidden');
                result.classList.add('hidden');
                hideError();
                transcribeBtn.disabled = true;
              }

              function hideLoading() {
                loading.classList.add('hidden');
              }

              function showResult(text) {
                resultContent.textContent = text;
                result.classList.remove('hidden');
                transcribeBtn.disabled = false;
              }

              uploadArea.addEventListener('click', function (e) {
                if (e.target === clearBtn) return;
                fileInput.click();
              });

              fileInput.addEventListener('change', function () {
                if (fileInput.files.length) setFile(fileInput.files[0]);
              });

              clearBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                clearFile();
              });

              uploadArea.addEventListener('dragover', function (e) {
                e.preventDefault();
                uploadArea.classList.add('drag-over');
              });

              uploadArea.addEventListener('dragleave', function () {
                uploadArea.classList.remove('drag-over');
              });

              uploadArea.addEventListener('drop', function (e) {
                e.preventDefault();
                uploadArea.classList.remove('drag-over');
                if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
              });

              transcribeBtn.addEventListener('click', async function () {
                if (!selectedFile) return;
                showLoading();

                var formData = new FormData();
                formData.append('file', selectedFile);

                try {
                  var resp = await fetch('/upload', { method: 'POST', body: formData });
                  if (!resp.ok) {
                    var body = await resp.text();
                    throw new Error(body || 'Server returned ' + resp.status);
                  }
                  var text = await resp.text();
                  hideLoading();
                  showResult(text);
                } catch (err) {
                  hideLoading();
                  showError(
                    'Failed to transcribe the PDF. ' + (err.message || 'Please try again.')
                  );
                  transcribeBtn.disabled = false;
                }
              });

              copyBtn.addEventListener('click', function () {
                navigator.clipboard.writeText(resultContent.textContent).then(function () {
                  copyBtn.textContent = 'Copied!';
                  setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
                });
              });
            </script>

            </body>
            </html>
            """;
}
