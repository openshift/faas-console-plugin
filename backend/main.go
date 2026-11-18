package main

import (
	"context"
	"crypto/tls"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/handler"
	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/kube"
	"github.com/openshift/faas-console-plugin/backend/monitoring"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
	"github.com/openshift/faas-console-plugin/backend/tlsreload"
)

const (
	defaultCAPath                 = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	defaultConsolePluginNamespace = "console-functions-plugin"
)

//go:embed all:static/*
var staticFiles embed.FS

func main() {
	httpPort := flag.Int("http-port", 8080, "HTTP server port")
	httpsPort := flag.Int("https-port", 8443, "HTTPS server port")
	certFile := flag.String("cert", "/var/cert/tls.crt", "TLS certificate file")
	keyFile := flag.String("key", "/var/cert/tls.key", "TLS key file")
	caPath := flag.String("kube-root-ca-path", defaultCAPath, "path to CA certificate for cluster TLS probe")
	kubeHost := flag.String("kube-host", "", "Kubernetes API server URL (empty uses in-cluster config)")
	kubeAPIServer := flag.String("external-api-server-url", "", "external Kubernetes API server URL embedded in generated kubeconfigs")
	clusterID := flag.String("cluster-id", "", "unique cluster identifier")
	ghAPIURL := flag.String("gh-api-url", "", "GitHub API base URL")
	saTokenExpiry := flag.String("sa-token-expiry", "", "ServiceAccount token expiry is a duration in common notation, e.g. 7d, 12h, 10m")
	thanosURL := flag.String("thanos-url", "", "Thanos querier base URL for metrics queries")
	thanosCAPath := flag.String("thanos-ca-path", "", "CA bundle path for Thanos TLS verification")
	flag.Parse()

	if *ghAPIURL != "" {
		baseURL := *ghAPIURL
		config.SCMRegistry = scm.Registry{
			scm.GitHub: func(pat string) scm.Client {
				return github.NewWithBaseURL(pat, baseURL)
			},
		}
		log.Printf("Using custom GitHub API URL: %s", baseURL)
	}

	if *kubeAPIServer == "" {
		log.Fatal("--external-api-server-url is required")
	}

	if *clusterID == "" {
		log.Fatal("--cluster-id is required")
	}

	if *thanosURL == "" {
		log.Fatal("--thanos-url is required (the frontend metrics views depend on it)")
	}

	if *thanosCAPath == "" {
		log.Fatal("--thanos-ca-path is required (TLS verification cannot be skipped)")
	}

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatalf("Failed to create sub filesystem: %v", err)
	}

	saTokenExpiryParsed := config.DefaultSATokenExpiry
	if saTokenExpiry != nil && *saTokenExpiry != "" {
		saTokenExpiryParsed, err = config.ParseSATokenExpiry(*saTokenExpiry)
		if err != nil {
			log.Fatalf("Failed to parse --sa-token-expiry=%s: %v", *saTokenExpiry, err)
		}
	}

	cfg, err := kube.ComponentConfig()
	if err != nil {
		log.Fatal(err)
	}

	namespace := kube.Namespace(defaultConsolePluginNamespace)
	caCert, err := readCACert(*caPath)
	if err != nil {
		log.Fatal(err)
	}

	scmCredentials, err := credentials.NewStore(cfg, namespace, identity.NewResolver(*kubeHost, caCert))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Storing SCM credentials as Secrets in namespace %q", namespace)

	var metricsClient *monitoring.Client
	metricsClient, err = monitoring.NewClient(*thanosURL, *thanosCAPath, monitoring.TokenSourceFromConfig(cfg))
	if err != nil {
		log.Fatalf("Failed to create metrics client: %v", err)
	}
	log.Printf("Metrics client configured for Thanos at %s", *thanosURL)

	h := handler.New(caCert, *kubeHost, *kubeAPIServer, *clusterID, saTokenExpiryParsed, scmCredentials, metricsClient)

	mux := newMux(h, scmCredentials, static)

	muxHandler := handler.LoggingMiddleware(mux)

	_, certErr := os.Stat(*certFile)
	_, keyErr := os.Stat(*keyFile)
	if certErr == nil && keyErr == nil {
		reloader, err := tlsreload.New(*certFile, *keyFile)
		if err != nil {
			log.Fatalf("Failed to load TLS certificate: %v", err)
		}

		go reloader.Run(context.Background())

		go func() {
			ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *httpPort))
			if err != nil {
				log.Fatal(err)
			}
			log.Printf("Listening on http://%s", ln.Addr())
			log.Fatal(http.Serve(ln, muxHandler))
		}()

		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *httpsPort))
		if err != nil {
			log.Fatal(err)
		}
		tlsLn := tls.NewListener(ln, &tls.Config{
			GetCertificate: reloader.GetCertificate,
		})
		log.Printf("Listening on https://%s", ln.Addr())
		log.Fatal(http.Serve(tlsLn, muxHandler))
	} else {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *httpPort))
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("TLS certificate not found, listening on http://%s", ln.Addr())
		log.Fatal(http.Serve(ln, muxHandler))
	}
}

func newMux(h *handler.Handlers, scmCredentials credentials.Provider, static fs.FS) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.HandleHealthz)
	// SSE reports failures inside the stream, so it checks the caller itself.
	mux.HandleFunc("GET /api/v1/func/workflow-run/watch", handler.WorkflowRunWatch(handler.WithCredentialsProvider(scmCredentials)))
	mux.Handle("/", http.FileServer(http.FS(static)))

	withCredential := func(next http.HandlerFunc) http.Handler {
		return handler.RequireSCMCredential(next, scmCredentials)
	}
	api := http.NewServeMux()
	api.HandleFunc("GET /api/v1/scm/github/credential", h.HandleGetSCMCredential)
	api.HandleFunc("POST /api/v1/scm/github/credential", h.HandleSaveSCMCredential)
	api.HandleFunc("DELETE /api/v1/scm/github/credential", h.HandleDeleteSCMCredential)
	api.Handle("GET /api/v1/func/list", withCredential(h.HandleListFunctions))
	api.Handle("GET /api/v1/func/{owner}/{name}/files", withCredential(h.HandleGetFiles))
	api.Handle("PUT /api/v1/func/{owner}/{name}/files", withCredential(h.HandlePutFiles))
	api.Handle("POST /api/v1/func/create", withCredential(h.HandleFuncCreate))
	api.HandleFunc("GET /api/v1/monitoring/metrics", h.HandleGetMetrics)
	mux.Handle("/api/v1/", handler.RequireOCPToken(api))
	return mux
}

func readCACert(path string) ([]byte, error) {
	if path == "" {
		return nil, nil
	}
	caCert, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read CA certificate %q: %w", path, err)
	}
	return caCert, nil
}
