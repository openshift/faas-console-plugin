import { createContext, ReactNode, useState } from 'react';
import { AuthUser, PAT_KEY, USER_KEY } from '../services/types';

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser;
  connectionId: number;
  onLogin: (user: AuthUser) => void;
}

export const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  user: { name: '', avatarUrl: '' },
  connectionId: 0,
  onLogin: () => {},
});

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(
    () => !!sessionStorage.getItem(PAT_KEY),
  );
  const [user, setUser] = useState<AuthUser>(readStoredUser);
  const [connectionId, setConnectionId] = useState(0);

  const onLogin = (authUser: AuthUser) => {
    setUser(authUser);
    setIsAuthenticated(true);
    setConnectionId((id) => id + 1);
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, connectionId, onLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

function readStoredUser(): AuthUser {
  const userJson = sessionStorage.getItem(USER_KEY);
  if (!userJson) return { name: '', avatarUrl: '' };
  try {
    return JSON.parse(userJson) as AuthUser;
  } catch {
    return { name: '', avatarUrl: '' };
  }
}
