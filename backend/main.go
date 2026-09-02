package main

import (
	"crypto/tls"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/handler"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
	"github.com/openshift/faas-console-plugin/backend/tlsreload"
)

const defaultCAPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

//go:embed static/*
var staticFiles embed.FS

func main() {
	httpPort := flag.Int("http-port", 8080, "HTTP server port")
	httpsPort := flag.Int("https-port", 8443, "HTTPS server port")
	certFile := flag.String("cert", "/var/cert/tls.crt", "TLS certificate file")
	keyFile := flag.String("key", "/var/cert/tls.key", "TLS key file")
	caPath := flag.String("kube-root-ca-path", defaultCAPath, "path to CA certificate for cluster TLS probe")
	kubeHost := flag.String("kube-host", "", "Kubernetes API server URL for dev/test (empty uses in-cluster config)")
	kubeAPIServer := flag.String("external-api-server-url", "", "external Kubernetes API server URL embedded in generated kubeconfigs")
	ghAPIURL := flag.String("gh-api-url", "", "GitHub API base URL (for testing with fake server)")
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

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatalf("Failed to create sub filesystem: %v", err)
	}

	h, err := handler.New(*caPath, *kubeHost, *kubeAPIServer)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.HandleHealthz)
	mux.HandleFunc("GET /api/v1/auth/user", h.HandleGetUser)
	mux.HandleFunc("GET /api/v1/func/list", h.HandleListFunctions)
	mux.HandleFunc("GET /api/v1/func/{owner}/{name}/files", h.HandleGetFiles)
	mux.HandleFunc("PUT /api/v1/func/{owner}/{name}/files", h.HandlePutFiles)
	mux.HandleFunc("POST /api/v1/func/create", h.HandleFuncCreate)
	mux.Handle("/", http.FileServer(http.FS(static)))

	muxHandler := loggingMiddleware(mux)

	_, certErr := os.Stat(*certFile)
	_, keyErr := os.Stat(*keyFile)
	if certErr == nil && keyErr == nil {
		reloader, err := tlsreload.New(*certFile, *keyFile)
		if err != nil {
			log.Fatalf("Failed to load TLS certificate: %v", err)
		}
		go reloader.Run()

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

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s %s", r.RemoteAddr, r.Method, r.URL.Path)
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic: %v", rec)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "internal server error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}
