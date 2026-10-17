import { createContext, ReactNode, useCallback, useEffect, useState } from 'react';
import { Spinner } from '@patternfly/react-core';
import { disconnect, fetchConnection } from '../clients/authClient';
import { AUTH_EXPIRED_EVENT, AuthUser } from '../types';

const NO_USER: AuthUser = { name: '', avatarUrl: '' };

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser;
  onLogin: (user: AuthUser) => void;
  onLogout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  user: NO_USER,
  onLogin: () => {},
  onLogout: async () => {},
});

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  // undefined until the backend answers, null once it says it holds nothing,
  // the account once it does. The first two have to differ or the gate below
  // cannot tell "not asked yet" from "nothing stored".
  const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);

  const onLogin = (authUser: AuthUser) => {
    setAuthUser(authUser);
  };

  const clearAuth = useCallback(() => {
    setAuthUser(null);
  }, []);

  const onLogout = async () => {
    await disconnect();
    clearAuth();
  };

  // The caller's OpenShift identity is the only key, so the backend can answer
  // this for a browser that holds nothing. A user who stored a PAT before is
  // connected here without typing it again.
  useEffect(() => {
    let cancelled = false;
    fetchConnection()
      .then((connected) => {
        if (cancelled) return;
        if (connected) onLogin(connected);
        else setAuthUser(null);
      })
      .catch(() => {
        // Stay disconnected: the user can still connect by hand.
        if (!cancelled) setAuthUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.addEventListener(AUTH_EXPIRED_EVENT, clearAuth);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, clearAuth);
  }, [clearAuth]);

  // Children mount only once the answer is in, so "not connected yet" is not a
  // state anything below here can observe. Rendering them earlier would prompt
  // for a PAT the backend may already hold.
  if (authUser === undefined) {
    return <Spinner aria-label="Loading" style={{ display: 'block', margin: '4rem auto' }} />;
  }

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: Boolean(authUser),
        user: authUser ?? NO_USER,
        onLogin,
        onLogout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
