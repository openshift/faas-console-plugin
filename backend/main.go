package main

import (
	"context"
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
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/handler"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
	"github.com/openshift/faas-console-plugin/backend/session"
	"github.com/openshift/faas-console-plugin/backend/tlsreload"
)

const (
	defaultCAPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	// defaultSessionNamespace is where the chart installs the plugin, and so
	// where its Secrets belong. It is the answer for local runs only: in the pod
	// POD_NAMESPACE reports where the chart actually went and wins. There is no
	// third way to set it, so dev sessions always land in one predictable place.
	defaultSessionNamespace = "console-functions-plugin"
)

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
	saTokenExpiry := flag.String("sa-token-expiry", "", "ServiceAccount token expiry is a duration in common notation, e.g. 7d, 12h, 10m")
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

	saTokenExpiryParsed := config.DefaultSATokenExpiry
	if saTokenExpiry != nil && *saTokenExpiry != "" {
		saTokenExpiryParsed, err = config.ParseSATokenExpiry(*saTokenExpiry)
		if err != nil {
			log.Fatalf("Failed to parse --sa-token-expiry=%s: %v", *saTokenExpiry, err)
		}
	}

	// A non-empty --kube-host means the backend runs outside the cluster, on a
	// developer's laptop.
	cfg, err := sessionRESTConfig(*kubeHost != "")
	if err != nil {
		log.Fatal(err)
	}

	namespace := os.Getenv("POD_NAMESPACE")
	if namespace == "" {
		namespace = defaultSessionNamespace
	}
	sessionStore, err := session.NewStore(cfg, namespace)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Storing sessions as Secrets in namespace %q", namespace)

	h, err := handler.New(*caPath, *kubeHost, *kubeAPIServer, saTokenExpiryParsed, sessionStore)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.HandleHealthz)
	mux.HandleFunc("POST /api/v1/auth/login", h.HandleLogin)
	mux.HandleFunc("POST /api/v1/auth/session", h.HandleResumeSession)
	mux.HandleFunc("POST /api/v1/auth/logout", h.HandleLogout)
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

// sessionRESTConfig builds the client config the session store talks to the
// cluster with. Outside the pod there is no ServiceAccount token to read, so a
// developer's kubeconfig stands in for it; both point at a real cluster.
func sessionRESTConfig(dev bool) (*rest.Config, error) {
	var cfg *rest.Config
	var err error
	if dev {
		rules := clientcmd.NewDefaultClientConfigLoadingRules()
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{}).ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig: %w", err)
		}
	} else {
		cfg, err = rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("load in-cluster config: %w", err)
		}
	}
	cfg.ContentConfig = rest.ContentConfig{ContentType: "application/json"}
	cfg.Timeout = 30 * time.Second
	return cfg, nil
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
