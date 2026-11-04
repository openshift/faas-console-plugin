import { useEffect, useState } from 'react';
import { NamespaceOptions } from '../types';
import { errorMessage } from '../errors';
import { getNamespaces } from './functionsClient';

interface UseNamespaceOptionsResult extends NamespaceOptions {
  loaded: boolean;
  error?: string;
}

const EMPTY: NamespaceOptions = { namespaces: [], canCreateNamespaces: false };

// The namespace choices a user is allowed to deploy into, as decided by the backend.
export function useNamespaceOptions(): UseNamespaceOptionsResult {
  const [options, setOptions] = useState<NamespaceOptions>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let ignore = false;

    getNamespaces()
      .then((result) => {
        if (!ignore) setOptions(result);
      })
      .catch((err) => {
        if (!ignore) setError(errorMessage(err));
      })
      .finally(() => {
        if (!ignore) setLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, []);

  return { ...options, loaded, error };
}
