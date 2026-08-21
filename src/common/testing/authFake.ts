import { PAT_KEY, USER_KEY } from '../types';

export function authenticateGithubFake() {
  sessionStorage.setItem(PAT_KEY, 'ghp_test');
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ name: 'twoGiants', avatarUrl: 'https://valid.url' }),
  );
}

export function logoutGithubFake() {
  sessionStorage.clear();
}
