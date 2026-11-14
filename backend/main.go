package main

import (
	"context"
	"crypto/tls"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/handler"
	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/kube"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
	"github.com/openshift/faas-console-plugin/backend/tlsreload"
)

const (
	defaultCAPath                 = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	defaultConsolePluginNamespace = "console-functions-plugin"

	shutdownTimeout = 5 * time.Second
)

//go:embed all:static/*
var staticFiles embed.FS

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := run(ctx, os.Args[1:])
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "ERROR: %s\n", err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	fgs := flag.NewFlagSet("plugin-backend", flag.ContinueOnError)
	httpPort := fgs.Int("http-port", 8080, "HTTP server port, used only when no TLS certificate is found")
	httpsPort := fgs.Int("https-port", 8443, "HTTPS server port")
	certFile := fgs.String("cert", "/var/cert/tls.crt", "TLS certificate file")
	keyFile := fgs.String("key", "/var/cert/tls.key", "TLS key file")
	caPath := fgs.String("kube-root-ca-path", defaultCAPath, "path to CA certificate for cluster TLS probe")
	kubeHost := fgs.String("kube-host", "", "Kubernetes API server URL (empty uses in-cluster config)")
	kubeAPIServer := fgs.String("external-api-server-url", "", "external Kubernetes API server URL embedded in generated kubeconfigs")
	clusterID := fgs.String("cluster-id", "", "unique cluster identifier")
	ghAPIURL := fgs.String("gh-api-url", "", "GitHub API base URL")
	saTokenExpiry := fgs.String("sa-token-expiry", "", "ServiceAccount token expiry is a duration in common notation, e.g. 7d, 12h, 10m")
	err := fgs.Parse(args)
	if errors.Is(err, flag.ErrHelp) {
		// Parse already printed the usage text.
		return nil
	}
	if err != nil {
		return fmt.Errorf("parse arguments: %w", err)
	}

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
		return fmt.Errorf("--external-api-server-url is required")
	}

	if *clusterID == "" {
		return fmt.Errorf("--cluster-id is required")
	}

	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return fmt.Errorf("failed to create sub filesystem: %v", err)
	}

	saTokenExpiryParsed := config.DefaultSATokenExpiry
	if saTokenExpiry != nil && *saTokenExpiry != "" {
		saTokenExpiryParsed, err = config.ParseSATokenExpiry(*saTokenExpiry)
		if err != nil {
			return fmt.Errorf("failed to parse --sa-token-expiry=%s: %v", *saTokenExpiry, err)
		}
	}

	cfg, err := kube.ComponentConfig()
	if err != nil {
		return err
	}

	namespace := kube.Namespace(defaultConsolePluginNamespace)
	caCert, err := readCACert(*caPath)
	if err != nil {
		return err
	}

	scmCredentials, err := credentials.NewStore(cfg, namespace, identity.NewResolver(*kubeHost, caCert))
	if err != nil {
		return err
	}
	log.Printf("Storing SCM credentials as Secrets in namespace %q", namespace)

	h := handler.New(caCert, *kubeHost, *kubeAPIServer, *clusterID, saTokenExpiryParsed, scmCredentials)

	mux := newMux(ctx, h, scmCredentials, static)

	muxHandler := handler.LoggingMiddleware(mux)

	_, certErr := os.Stat(*certFile)
	_, keyErr := os.Stat(*keyFile)
	var listener net.Listener
	if certErr == nil && keyErr == nil {
		reloader, err := tlsreload.New(*certFile, *keyFile)
		if err != nil {
			return fmt.Errorf("failed to load TLS certificate: %v", err)
		}

		go reloader.Run(ctx)

		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *httpsPort))
		if err != nil {
			return fmt.Errorf("listen on https port %d: %w", *httpsPort, err)
		}
		listener = tls.NewListener(ln, &tls.Config{
			GetCertificate: reloader.GetCertificate,
		})
		log.Printf("Listening on https://%s", ln.Addr())
	} else {
		listener, err = net.Listen("tcp", fmt.Sprintf(":%d", *httpPort))
		if err != nil {
			return fmt.Errorf("listen on http port %d: %w", *httpPort, err)
		}
		log.Printf("TLS certificate not found, listening on http://%s", listener.Addr())
	}
	defer listener.Close()

	server := http.Server{
		Handler: muxHandler,
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- server.Serve(listener)
	}()

	select {
	case err := <-serveDone:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", err)
		}
		return nil

	case <-ctx.Done():
		log.Printf("Signal received, draining in-flight requests for up to %s", shutdownTimeout)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		err := server.Shutdown(shutdownCtx)
		if errors.Is(err, context.DeadlineExceeded) {
			// Shutdown waits for active connections to fall idle but never cancels
			// an in-flight request, so streaming handlers such as the workflow run
			// watch outlast the budget. Close drops the connections, which cancels
			// their request contexts and lets those handlers return.
			log.Printf("Drain budget of %s expired, closing remaining connections", shutdownTimeout)
			err = server.Close()
		}
		serveErr := <-serveDone
		if err != nil {
			return fmt.Errorf("shut down: %w", err)
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", serveErr)
		}
		return nil
	}
}

func newMux(shutdownCtx context.Context, h *handler.Handlers, scmCredentials credentials.Provider, static fs.FS) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.HandleHealthz)
	// SSE reports failures inside the stream, so it checks the caller itself.
	mux.Handle("GET /api/v1/func/workflow-run/watch", handler.CancelOnShutdown(shutdownCtx,
		handler.WorkflowRunWatch(handler.WithCredentialsProvider(scmCredentials))))
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
