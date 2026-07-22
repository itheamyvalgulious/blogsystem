export function requestWorkbenchKeyboardLock() {
  const keyboardApi = (navigator as Navigator & {
    keyboard?: {
      lock: (codes?: string[]) => Promise<void>;
      unlock: () => void;
    };
  }).keyboard;

  if (!keyboardApi?.lock) {
    return;
  }

  const codes = ["KeyW", "PageUp", "PageDown", ...Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`)];
  void keyboardApi.lock(codes).catch(() => undefined);
}
