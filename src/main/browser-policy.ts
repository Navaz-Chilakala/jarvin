/** Preference for tasks that explicitly ask the assistant to use Chrome. */
export const VISIBLE_CHROME_PROMPT = 'When asked only to open Chrome, call launch_app with app Chrome; no search query is needed. If the user asks you to use Chrome or a visible browser to search or obtain information, first call chrome_search with a concise search query. Then call desktop_list_windows to find Chrome, focus_window to bring it to the foreground, and see_window to capture and visually read the Chrome page. Use visual_click for requested controls; it clicks the real mouse and observes the screen afterward. Use visual_type to fill a visible field with the real mouse and keyboard and observe its result; it does not submit forms. Use traverse_ui to move to the next or previous browser tab or Windows window and inspect the new image. Use keyboard_press for navigation, and capture again to verify the result. Do not replace visual reading with desktop_inspect_window, web_search, web_fetch, research_web, or a hidden browser. If you cannot see or verify the visible results, say so instead of inventing an answer.';

/** Only a complete, uncomplicated request qualifies for the fast launch path. */
export function isSimpleChromeLaunch(text: string): boolean {
  const command = text.trim().replace(/^(?:hey|hi|hello)\b[^.!?]{0,45}[.!?]\s*/i, '');
  return /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:google\s+)?chrome(?:\s+browser)?(?:\s+please)?[.!?]*$/i.test(command);
}
