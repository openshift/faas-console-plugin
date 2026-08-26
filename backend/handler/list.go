package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"golang.org/x/sync/errgroup"
	"sigs.k8s.io/yaml"

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
	Owner         string         `json:"owner"`
	RepoName      string         `json:"repoName"`
	RepoURL       string         `json:"repoURL"`
	DefaultBranch string         `json:"defaultBranch"`
	Name          string         `json:"name"`
	Namespace     string         `json:"namespace"`
	Runtime       string         `json:"runtime"`
	Source        functionSource `json:"source"`
	Err           string         `json:"err,omitempty"`
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
	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}
	ocpToken, ok := extractOCPToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Authorization header is required")
		return
	}

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
		repoFunctions, repoErr = listRepoFunctions(r.Context(), pat, namespace)
	}()
	go func() {
		defer wg.Done()
		clusterFunctions, clusterErr = h.listClusterFunctions(r.Context(), ocpToken, namespace)
	}()
	wg.Wait()

	// An invalid SCM token is a client error worth surfacing on its own.
	if errors.Is(repoErr, scm.ErrUnauthorized) {
		writeError(w, http.StatusUnauthorized, "invalid SCM token")
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

func listRepoFunctions(ctx context.Context, pat, namespace string) ([]listItem, error) {
	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)

	repos, err := client.ListRepos(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]listItem, len(repos))
	for i, repo := range repos {
		items[i] = listItem{
			Owner:         repo.Owner,
			RepoName:      repo.Name,
			RepoURL:       repo.URL,
			DefaultBranch: repo.DefaultBranch,
			Source:        sourceRepo,
		}
	}

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, repo := range repos {
		g.Go(func() error {
			content, err := client.GetFileContent(gctx, repo.Owner, repo.Name, repo.DefaultBranch, "func.yaml")
			if err != nil {
				slog.Warn("failed to read func.yaml", "repo", repo.Owner+"/"+repo.Name, "err", err)
				items[i].Err = "failed to read func.yaml"
				return nil
			}
			name, namespace, runtime, parseErr := parseFuncYaml(content)
			if parseErr != nil {
				slog.Warn("failed to parse func.yaml", "repo", repo.Owner+"/"+repo.Name, "err", parseErr)
				items[i].Err = "invalid func.yaml"
				return nil
			}
			items[i].Name = name
			items[i].Namespace = namespace
			items[i].Runtime = runtime
			return nil
		})
	}
	_ = g.Wait()

	if namespace != "" {
		items = filterByNamespace(items, namespace)
	}

	return items, nil
}

func filterByNamespace(items []listItem, namespace string) []listItem {
	filtered := make([]listItem, 0, len(items))
	for _, item := range items {
		if item.Namespace == namespace {
			filtered = append(filtered, item)
		}
	}
	return filtered
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
