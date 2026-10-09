import { resetFakeGithub } from './helpers/fakegithub';

export default async function globalTeardown() {
  await resetFakeGithub();
}
