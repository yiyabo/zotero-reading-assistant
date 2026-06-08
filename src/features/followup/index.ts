import { setFollowupWindowRenderer } from "./FollowupWindow";
import { renderFollowupWindow } from "./FollowupRenderer";

export function initFollowup(): void {
  setFollowupWindowRenderer((win, ctx) => renderFollowupWindow(win, ctx));
}

export { openFollowupWindow, closeFollowupWindow } from "./FollowupWindow";
export type { FollowupWindowContext } from "./FollowupWindow";
