export const CTRL_C_QUIT_WINDOW_MS = 1500;

export const ESC_CANCEL_WINDOW_MS = 1500;

/** Collapses one physical Esc reaching several handlers into a single logical
 *  press. Well under a human double-tap, so it cannot swallow a real second
 *  press on any platform. */
export const ESC_SAME_PRESS_MS = 80;
