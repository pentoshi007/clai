type AsyncFs = typeof import("node:fs/promises");

export function withWindowsAppendHandles(actual: AsyncFs): AsyncFs {
  return {
    ...actual,
    async open(...args: Parameters<AsyncFs["open"]>) {
      const handle = await actual.open(...args);
      if (args[1] === "a+") {
        handle.truncate = () => Promise.reject(Object.assign(
          new Error("EPERM: operation not permitted, ftruncate"), { code: "EPERM" },
        ));
      }
      return handle;
    },
  };
}
