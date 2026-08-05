package scaffold

import (
	"fmt"

	"knative.dev/func/pkg/functions"
)

func envVarToFuncEnv(ev EnvVar) functions.Env {
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
	return functions.Env{Name: &name, Value: &value}
}

func injectEnvVars(root string, envs []EnvVar) error {
	fn, err := functions.NewFunction(root)
	if err != nil {
		return fmt.Errorf("load function: %w", err)
	}
	for _, ev := range envs {
		fn.Run.Envs = append(fn.Run.Envs, envVarToFuncEnv(ev))
	}
	if err := fn.Write(); err != nil {
		return fmt.Errorf("write function: %w", err)
	}
	return nil
}
