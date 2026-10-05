import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerRequest } from "../../controllers/overlay-controller.js";

export function pickAuthMethod(services: AppServices, request: PickerRequest): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (value !== undefined) services.overlay.close();
      resolve(value);
    };
    const opened = services.overlay.openPicker(request, (value) => {
      finish(request.options.some((option) => option.value === value) ? value : undefined);
    });
    if (!opened) {
      finish();
      return;
    }
    if (!settled) {
      unsubscribe = services.overlay.subscribe(() => {
        if (!services.overlay.isOpen()) finish();
      });
    }
  });
}
