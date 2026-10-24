import { Alert, Bullseye, Spinner } from '@patternfly/react-core';
import { createContext, ReactNode, useCallback, useEffect, useState } from 'react';
import { disconnectGithubUser, fetchGithubUser } from '../clients/authClient';
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
  // undefined until the backend answers, null once it says it holds nothing
  const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);
  const [showExpiredAlert, setShowExpiredAlert] = useState(false);

  const onLogin = (authUser: AuthUser) => {
    setAuthUser(authUser);
    setShowExpiredAlert(false);
  };

  const onAuthExpired = useCallback(() => {
    setAuthUser(null);
    setShowExpiredAlert(true);
  }, []);

  const onLogout = async () => {
    await disconnectGithubUser();
    setAuthUser(null);
  };

  useEffect(() => {
    let cancelled = false;
    fetchGithubUser()
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
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, [onAuthExpired]);

  if (authUser === undefined) {
    return (
      <Bullseye>
        <Spinner aria-label="Loading" />
      </Bullseye>
    );
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
      {showExpiredAlert && (
        <Alert
          variant="warning"
          title="Your GitHub session has expired. Click 'Connect to GitHub' to reconnect."
          isInline
          className="pf-v6-u-m-md"
        />
      )}
      {children}
    </AuthContext.Provider>
  );
}
