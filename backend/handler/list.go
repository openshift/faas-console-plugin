package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
	"sigs.k8s.io/yaml"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

var newFunctionsClient = functions.NewClient

type functionSource string

const (
	sourceRepo    functionSource = "repo"
	sourceCluster functionSource = "cluster"
)

type listItem struct {
	Owner         string         `json:"owner,omitempty"`
	RepoName      string         `json:"repoName,omitempty"`
	RepoURL       string         `json:"repoURL,omitempty"`
	DefaultBranch string         `json:"defaultBranch,omitempty"`
	Name          string         `json:"name,omitempty"`
	Namespace     string         `json:"namespace,omitempty"`
	Runtime       string         `json:"runtime,omitempty"`
	Source        functionSource `json:"source"`
	Err           string         `json:"error,omitempty"`
}

type funcKey struct {
	namespace string
	name      string
}

type funcYamlFields struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Runtime   string `json:"runtime"`
}

func (h *Handlers) HandleListFunctions(w http.ResponseWriter, r *http.Request) {
	credential := credentialFrom(r.Context())

	all := r.URL.Query().Get("all") == "true"
	namespace := r.URL.Query().Get("namespace")
	if !all && namespace == "" {
		writeError(w, http.StatusBadRequest, "namespace query parameter is required unless all=true")
		return
	}

	if all {
		namespace = ""
	}

	var (
		repoFunctions    []listItem
		repoErr          error
		clusterFunctions []listItem
		clusterErr       error
	)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		repoFunctions, repoErr = h.listRepoFunctions(r.Context(), credential.Token, credential.ocpToken, namespace)
	}()
	go func() {
		defer wg.Done()
		clusterFunctions, clusterErr = h.listClusterFunctions(r.Context(), credential.ocpToken, namespace)
	}()
	wg.Wait()

	// An invalid SCM token is a client error worth surfacing on its own.
	if errors.Is(repoErr, scm.ErrUnauthorized) {
		writeError(w, http.StatusForbidden, "invalid SCM token")
		return
	}
	if repoErr != nil {
		slog.Error("failed to list repos", "err", repoErr)
	}
	// A failure of a single source is non-fatal: we still return whatever the
	// other source found. Only when both sources fail do we have nothing to
	// return and report an error.
	if repoErr != nil && clusterErr != nil {
		writeError(w, http.StatusBadGateway, "failed to list functions from repositories and cluster")
		return
	}

	repoKeys := make(map[funcKey]bool, len(repoFunctions))
	for _, rf := range repoFunctions {
		if rf.Name != "" {
			repoKeys[funcKey{rf.Namespace, rf.Name}] = true
		}
	}

	items := make([]listItem, 0, len(repoFunctions)+len(clusterFunctions))
	items = append(items, repoFunctions...)
	for _, clusterFn := range clusterFunctions {
		if repoKeys[funcKey{clusterFn.Namespace, clusterFn.Name}] {
			continue
		}
		items = append(items, clusterFn)
	}

	writeJSON(w, http.StatusOK, items)
}

func (h *Handlers) listRepoFunctions(ctx context.Context, pat, ocpToken, namespace string) ([]listItem, error) {
	scmClient := config.SCMRegistry.Client(scm.DefaultPlatform, pat)

	repos, err := scmClient.ListRepos(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]listItem, len(repos))
	excluded := make([]bool, len(repos))

	clusterClient, err := newClusterClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		slog.Error("failed to create cluster client for namespace validation", "err", err)
		return nil, err
	}

	type nsResult struct{ err error }
	var sfGroup singleflight.Group
	var nsCache sync.Map
	// checkNamespaceCached caches namespace check results and coalesces concurrent
	// calls for the same key so at most one cluster API call is in flight per namespace.
	checkNamespaceCached := func(ctx context.Context, ns string) error {
		if v, ok := nsCache.Load(ns); ok {
			return v.(nsResult).err
		}
		_, err, _ := sfGroup.Do(ns, func() (any, error) {
			e := clusterClient.CheckNamespace(ctx, ns)
			nsCache.Store(ns, nsResult{err: e})
			return nil, e
		})
		return err //nolint:wrapcheck // sentinel errors from CheckNamespace carry full context
	}

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, repo := range repos {
		g.Go(func() error {
			items[i] = listItem{
				Owner:         repo.Owner,
				RepoName:      repo.Name,
				RepoURL:       repo.URL,
				DefaultBranch: repo.DefaultBranch,
				Source:        sourceRepo,
			}

			repoClusterURL, err := scmClient.GetVariable(gctx, repo.Owner, repo.Name, repoVarClusterAPIURL)
			if err != nil {
				slog.Warn("failed to read variable", "variable", repoVarClusterAPIURL, "repo", repo.Owner+"/"+repo.Name, "err", err)
				// keep the repo on transient errors rather than hiding it
			} else if repoClusterURL != h.externalAPIServerURL {
				// Filter out repos whose CLUSTER_API_URL variable does not match this cluster. The variable is written alongside
				// the KUBECONFIG secret at repo creation, so a mismatch means the secret points to a different cluster
				// (from where it was created) and deploying from this console would target the wrong cluster.
				excluded[i] = true
				return nil
			}

			content, err := scmClient.GetFileContent(gctx, repo.Owner, repo.Name, repo.DefaultBranch, "func.yaml")
			if err != nil {
				slog.Warn("failed to read func.yaml", "repo", repo.Owner+"/"+repo.Name, "err", err)
				items[i].Err = "func.yaml: failed to read"
				return nil
			}
			name, funcNamespace, runtime, parseErr := parseFuncYaml(content)
			if parseErr != nil {
				slog.Warn("failed to parse func.yaml", "repo", repo.Owner+"/"+repo.Name, "err", parseErr)
				// If the function is already deployed it will appear as a duplicate entry
				// because deduplication requires a namespace key and parsing failed here.
				// See SRVOCF-1138.
				items[i].Err = "func.yaml: invalid"
				return nil
			}
			items[i].Name = name
			items[i].Namespace = funcNamespace
			items[i].Runtime = runtime

			if namespace != "" && funcNamespace != namespace {
				excluded[i] = true
				return nil
			}

			switch nsErr := checkNamespaceCached(gctx, funcNamespace); {
			case errors.Is(nsErr, cluster.ErrNamespaceForbidden):
				items[i].Err = "func.yaml: namespace access denied"
			case errors.Is(nsErr, cluster.ErrNamespaceNotFound):
				// Note: even after recreating the namespace the stored KUBECONFIG
				// will be stale because the original ServiceAccount no longer exists.
				// Recovery requires re-creating the function. See SRVOCF-1137.
				items[i].Err = "func.yaml: namespace does not exist"
			case nsErr != nil:
				slog.Warn("failed to check namespace existence", "namespace", funcNamespace, "err", nsErr)
				items[i].Err = "func.yaml: namespace check failed"
			}
			return nil
		})
	}
	_ = g.Wait()

	filtered := items[:0]
	for i, item := range items {
		if !excluded[i] {
			filtered = append(filtered, item)
		}
	}
	return filtered, nil
}

func (h *Handlers) listClusterFunctions(ctx context.Context, ocpToken, namespace string) ([]listItem, error) {
	client, err := newFunctionsClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		slog.Warn("failed to connect to cluster", "err", err)
		return nil, err
	}
	funcs, err := client.List(ctx, namespace)
	if err != nil {
		slog.Warn("failed to list cluster functions", "err", err)
		return nil, err
	}

	items := make([]listItem, len(funcs))
	for i, fn := range funcs {
		items[i] = listItem{
			Name:      fn.Name,
			Namespace: fn.Namespace,
			Runtime:   fn.Runtime,
			Source:    sourceCluster,
		}
	}
	return items, nil
}

func parseFuncYaml(content string) (name, namespace, runtime string, err error) {
	var f funcYamlFields
	if err := yaml.Unmarshal([]byte(content), &f); err != nil {
		return "", "", "", fmt.Errorf("invalid func.yaml: %w", err)
	}
	return f.Name, f.Namespace, f.Runtime, nil
}
