export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) => message.startsWith('Red Hat Konflux'),
    (message) => message.startsWith('Merge commit'),
  ],
};
