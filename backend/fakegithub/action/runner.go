package action

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type Executor interface {
	Run(ctx context.Context, req RunRequest) (RunResult, error)
}

type RunRequest struct {
	Workdir   string
	Secrets   map[string]string
	Vars      map[string]string
	Env       map[string]string
	EventName string
	Output    io.Writer
}

type RunResult struct {
	Conclusion string
	Log        []byte
}

// writePythonShims creates a temp dir with unversioned python/pip wrappers
// for systems where only the versioned commands are on PATH.
// shims maps command name to script body; only non-empty entries are written.
// Returns the dir path; the caller is responsible for removing it.
func writePythonShims(shims map[string]string) (string, error) {
	dir, err := os.MkdirTemp("", "python-shim-*")
	if err != nil {
		return "", fmt.Errorf("create python shim dir: %w", err)
	}
	for name, script := range shims {
		p := filepath.Join(dir, name)
		if writeErr := os.WriteFile(p, []byte(script), 0o755); writeErr != nil {
			os.RemoveAll(dir)
			return "", fmt.Errorf("write python shim %s: %w", name, writeErr)
		}
	}
	return dir, nil
}

// When func is pre-installed in the image, passing this dir via act's
// --local-repository flag replaces the remote action so no download
// is attempted. Returns the dir path; the caller is responsible for removing it.
func writeSkipAction() (string, error) {
	dir, err := os.MkdirTemp("", "func-action-shim-*")
	if err != nil {
		return "", fmt.Errorf("create skip-action dir: %w", err)
	}
	actionYAML := "runs:\n  using: composite\n  steps:\n    - run: 'true'\n      shell: sh\n"
	if err := os.WriteFile(filepath.Join(dir, "action.yml"), []byte(actionYAML), 0o644); err != nil {
		os.RemoveAll(dir)
		return "", fmt.Errorf("write action.yml: %w", err)
	}
	return dir, nil
}

// buildHostEnv builds the environment for act, starting from the current
// process env and patching common macOS issues that arise because act runs
// as a subprocess and may not inherit a full login-shell environment.
// The returned cleanup func must be called when the act process exits.
func buildHostEnv() ([]string, func()) {
	env := os.Environ()
	var cleanups []func()
	cleanup := func() {
		for _, fn := range cleanups {
			fn()
		}
	}

	// macOS (Homebrew Python, PEP 668): pip refuses system-wide installs unless this
	// env var is set. UBI9/RHEL Python installed via dnf does not set the
	// EXTERNALLY-MANAGED marker, so this is only needed on macOS.
	if runtime.GOOS == "darwin" {
		env = setEnv(env, "PIP_BREAK_SYSTEM_PACKAGES", "1")
	}

	// Python: create unversioned pip/python shims when they are missing.
	// pip uses "python3 -m pip" so it works even when the pip3 binary is absent.
	_, pipMissing := exec.LookPath("pip")
	_, pythonMissing := exec.LookPath("python")
	_, python3Err := exec.LookPath("python3")
	shims := map[string]string{}
	if pipMissing != nil && python3Err == nil {
		shims["pip"] = "#!/bin/sh\nexec python3 -m pip \"$@\"\n"
	}
	if pythonMissing != nil && python3Err == nil {
		shims["python"] = "#!/bin/sh\nexec python3 \"$@\"\n"
	}
	if len(shims) > 0 {
		if shimDir, shimErr := writePythonShims(shims); shimErr == nil {
			env = prependPath(env, shimDir)
			cleanups = append(cleanups, func() { os.RemoveAll(shimDir) })
		}
	}

	return env, cleanup
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, e := range env {
		if strings.HasPrefix(e, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func prependPath(env []string, dir string) []string {
	for i, e := range env {
		if after, ok := strings.CutPrefix(e, "PATH="); ok {
			env[i] = "PATH=" + dir + ":" + after
			return env
		}
	}
	return append(env, "PATH="+dir+":"+os.Getenv("PATH"))
}

type ActExecutor struct {
	Platform string
}

func NewActExecutor() *ActExecutor {
	return &ActExecutor{Platform: "ubuntu-latest=-self-hosted"}
}

func (e *ActExecutor) Run(ctx context.Context, req RunRequest) (RunResult, error) {
	args := []string{
		req.EventName,
		"-P", e.Platform,
		"--directory", req.Workdir,
	}
	for name, val := range req.Secrets {
		args = append(args, "--secret", fmt.Sprintf("%s=%s", name, val))
	}
	for name, val := range req.Vars {
		args = append(args, "--var", fmt.Sprintf("%s=%s", name, val))
	}
	for name, val := range req.Env {
		args = append(args, "--env", fmt.Sprintf("%s=%s", name, val))
	}

	// A local no-op shim so the "Install func cli" step skips the download when already present.
	// Temporary until https://github.com/nektos/act/pull/6182 is released as
	// using a pre-installed func reduces the similarity with real GitHub Actions flow.
	// We might howevever want to keep this shim for local dev, as it allows using a func binary under development.
	if _, err := exec.LookPath("func"); err == nil {
		if shimDir, shimErr := writeSkipAction(); shimErr == nil {
			args = append(args, "--local-repository", "functions-dev/action@main="+shimDir)
			defer os.RemoveAll(shimDir)
		}
	}

	cmd := exec.CommandContext(ctx, "act", args...)
	cmd.Dir = req.Workdir

	env, cleanupEnv := buildHostEnv()
	defer cleanupEnv()
	cmd.Env = env

	var buf bytes.Buffer
	out := req.Output
	if out == nil {
		out = &buf
	}
	cmd.Stdout = out
	cmd.Stderr = out

	conclusion := "success"
	if err := cmd.Run(); err != nil {
		conclusion = "failure"
		_, _ = fmt.Fprintf(out, "\nact error: %v\n", err)
	}
	return RunResult{Conclusion: conclusion, Log: buf.Bytes()}, nil
}
