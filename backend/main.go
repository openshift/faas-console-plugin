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

	"github.com/openshift/faas-console-plugin/backend/handler"
)

//go:embed static/*
var staticFiles embed.FS

func main() {
	httpPort := flag.Int("http-port", 8080, "HTTP server port")
	httpsPort := flag.Int("https-port", 8443, "HTTPS server port")
	certFile := flag.String("cert", "/var/cert/tls.crt", "TLS certificate file")
	keyFile := flag.String("key", "/var/cert/tls.key", "TLS key file")
	caPath := flag.String("kube-root-ca-path", defaultCAPath, "path to CA certificate for cluster TLS probe")
	kubeAPIServer := flag.String("kube-api-server", "", "Kubernetes API server URL (overrides KUBERNETES_SERVICE_HOST/PORT and request body)")
	saTokenExpiry := flag.Int64("sa-token-expiry", 0, "service account token lifetime in seconds (0 = use DefaultTokenExpiry)")
	flag.Parse()

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatalf("Failed to create sub filesystem: %v", err)
	}

	h := handler.New(*caPath, *kubeAPIServer, *saTokenExpiry)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/function/create", handleFuncCreate)
	mux.Handle("GET /api/cluster/ca", &clusterCAHandler{CAPath: *caPath})
	mux.HandleFunc("GET /api/v1/auth/user", h.HandleAuthLogin)
	mux.HandleFunc("GET /api/v1/func/{owner}/{name}/files", h.HandleGetFiles)
	mux.HandleFunc("PUT /api/v1/func/{owner}/{name}/files", h.HandlePutFiles)
	mux.HandleFunc("POST /api/v1/func/create", h.HandleFuncCreate)
	mux.Handle("/", http.FileServer(http.FS(static)))

	muxHandler := loggingMiddleware(mux)

	_, certErr := os.Stat(*certFile)
	_, keyErr := os.Stat(*keyFile)
	if certErr == nil && keyErr == nil {
		go func() {
			ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *httpPort))
			if err != nil {
				log.Fatal(err)
			}
			log.Printf("Listening on http://%s", ln.Addr())
			log.Fatal(http.Serve(ln, muxHandler))
		}()

		cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
		if err != nil {
			log.Fatalf("Failed to load TLS certificate: %v", err)
		}
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *httpsPort))
		if err != nil {
			log.Fatal(err)
		}
		tlsLn := tls.NewListener(ln, &tls.Config{
			Certificates: []tls.Certificate{cert},
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
		next.ServeHTTP(w, r)
	})
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"message": msg})
}

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
