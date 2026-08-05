import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import { AuthUser } from '../types';

const PROXY_BASE = '/api/proxy/plugin/console-functions-plugin/backend';

interface AuthService {
  validateToken(pat: string): Promise<AuthUser>;
}

export function useAuthService(): AuthService {
  return useMemo(
    () => ({
      async validateToken(pat: string): Promise<AuthUser> {
        const resp = await consoleFetchJSON(`${PROXY_BASE}/api/v1/auth/user`, 'GET', {
          headers: { 'X-SCM-Token': pat },
        });
        return { name: resp.login, avatarUrl: resp.avatarUrl };
      },
    }),
    [],
  );
}
