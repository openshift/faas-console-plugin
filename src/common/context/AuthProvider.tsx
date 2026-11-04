import { Alert, Bullseye, Spinner } from '@patternfly/react-core';
import { createContext, ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { disconnectGithubUser, fetchGithubUser } from '../clients/authClient';
import { AUTH_EXPIRED_EVENT, AuthUser } from '../types';

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  onLogin: (user: AuthUser) => void;
  onLogout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  user: null,
  onLogin: () => {},
  onLogout: async () => {},
});

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const navigate = useNavigate();
  // undefined until the backend answers, null once it says it holds nothing
  const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);
  const [showExpiredAlert, setShowExpiredAlert] = useState(false);

  const onLogin = (authUser: AuthUser) => {
    setAuthUser(authUser);
    setShowExpiredAlert(false);
  };

  const onLogout = async () => {
    await disconnectGithubUser();
    setAuthUser(null);
    navigate('/faas');
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const connected = await fetchGithubUser();
        if (cancelled) return;
        if (connected) onLogin(connected);
        else setAuthUser(null);
      } catch {
        // Stay disconnected: the user can still connect by hand.
        if (!cancelled) setAuthUser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen only while connected: a credential can only expire if there was
  // one, so a 401 for a user who never connected is not an expiry.
  useEffect(() => {
    if (!authUser) return;
    const onAuthExpired = () => {
      setAuthUser(null);
      setShowExpiredAlert(true);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, [authUser]);

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
        user: authUser ?? null,
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
