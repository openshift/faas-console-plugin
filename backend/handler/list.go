package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

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

	namespace := r.URL.Query().Get("namespace")

	repoFunctions, err := listRepoFunctions(r.Context(), pat)
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("failed to list repos", "err", err)
		writeError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}

	clusterFunctions := h.listClusterFunctions(r.Context(), ocpToken, namespace)

	repoNames := make(map[string]bool, len(repoFunctions))
	for _, rf := range repoFunctions {
		if rf.Name != "" {
			repoNames[rf.Name] = true
		}
	}

	items := repoFunctions
	for _, clusterFn := range clusterFunctions {
		if repoNames[clusterFn.Name] {
			continue
		}
		items = append(items, clusterFn)
	}

	writeJSON(w, http.StatusOK, items)
}

func listRepoFunctions(ctx context.Context, pat string) ([]listItem, error) {
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

	return items, nil
}

func (h *Handlers) listClusterFunctions(ctx context.Context, ocpToken, namespace string) []listItem {
	client, err := newFunctionsClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		slog.Warn("failed to connect to cluster", "err", err)
		return nil
	}
	funcs, err := client.List(ctx, namespace)
	if err != nil {
		slog.Warn("failed to list cluster functions", "err", err)
		return nil
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
	return items
}

func parseFuncYaml(content string) (name, namespace, runtime string, err error) {
	var f funcYamlFields
	if err := yaml.Unmarshal([]byte(content), &f); err != nil {
		return "", "", "", fmt.Errorf("invalid func.yaml: %w", err)
	}
	return f.Name, f.Namespace, f.Runtime, nil
}
