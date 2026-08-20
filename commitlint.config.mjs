export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) => message.includes('red-hat-konflux'),
    (message) => message.startsWith('Merge commit'),
  ],
};
