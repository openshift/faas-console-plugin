package cluster

import (
	"context"
	"fmt"
	"log/slog"
)

type Provisioned struct {
	ServiceAccount      bool
	Role                bool
	RoleBinding         bool
	ImageBuilderBinding bool
}

func ProvisionRBAC(ctx context.Context, client Client, namespace string) (Provisioned, error) {
	var p Provisioned
	var err error

	p.ServiceAccount, err = client.CreateServiceAccount(ctx, namespace)
	if err != nil {
		return p, fmt.Errorf("create service account: %w", err)
	}
	p.Role, err = client.ApplyRole(ctx, namespace)
	if err != nil {
		return p, fmt.Errorf("apply role: %w", err)
	}
	p.RoleBinding, err = client.CreateRoleBinding(ctx, namespace)
	if err != nil {
		return p, fmt.Errorf("create role binding: %w", err)
	}
	p.ImageBuilderBinding, err = client.CreateImageBuilderBinding(ctx, namespace)
	if err != nil {
		return p, fmt.Errorf("create image builder binding: %w", err)
	}

	return p, nil
}

func RollbackProvisionedRBAC(ctx context.Context, client Client, namespace string, p Provisioned) {
	if p.ImageBuilderBinding {
		if err := client.DeleteImageBuilderBinding(ctx, namespace); err != nil {
			slog.Warn("rollback: failed to delete image builder binding", "namespace", namespace, "err", err)
		}
	}
	if p.RoleBinding {
		if err := client.DeleteRoleBinding(ctx, namespace); err != nil {
			slog.Warn("rollback: failed to delete role binding", "namespace", namespace, "err", err)
		}
	}
	if p.Role {
		if err := client.DeleteRole(ctx, namespace); err != nil {
			slog.Warn("rollback: failed to delete role", "namespace", namespace, "err", err)
		}
	}
	if p.ServiceAccount {
		if err := client.DeleteServiceAccount(ctx, namespace); err != nil {
			slog.Warn("rollback: failed to delete service account", "namespace", namespace, "err", err)
		}
	}
}
