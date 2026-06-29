export {};

declare global {
  interface Window {
    SERVER_FLAGS?: {
      authDisabled?: boolean;
    };
  }
}
