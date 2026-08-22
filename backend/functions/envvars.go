package functions

import (
	"fmt"

	fn "knative.dev/func/pkg/functions"
)

func envVarToFuncEnv(ev EnvVar) fn.Env {
	name := ev.Name
	var value string
	switch ev.Source {
	case "secret":
		value = fmt.Sprintf("{{ secret:%s:%s }}", ev.ResourceName, ev.ResourceKey)
	case "configMap":
		value = fmt.Sprintf("{{ configMap:%s:%s }}", ev.ResourceName, ev.ResourceKey)
	default:
		value = ev.Value
	}
	return fn.Env{Name: &name, Value: &value}
}

func injectEnvVars(root string, envs []EnvVar) error {
	f, err := fn.NewFunction(root)
	if err != nil {
		return fmt.Errorf("load function: %w", err)
	}
	for _, ev := range envs {
		f.Run.Envs = append(f.Run.Envs, envVarToFuncEnv(ev))
	}
	if err := f.Write(); err != nil {
		return fmt.Errorf("write function: %w", err)
	}
	return nil
}
