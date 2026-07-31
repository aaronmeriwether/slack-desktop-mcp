import { SizeHint, Webview } from "webview-bun";
import { lib } from "webview-bun/src/ffi";

const WIDTH = 440;
const START_HEIGHT = 150; // above any OS minimum, or the delta below is measured against a clamped window
const MAX_HEIGHT = 640;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function showErrorDialog(message: string): void {
  const webview = new Webview(false, { width: WIDTH, height: START_HEIGHT, hint: SizeHint.FIXED });
  webview.title = "slack-desktop-mcp — Error";

  const handle = webview.unsafeHandle;
  // terminate, not destroy: run() does the teardown once it unblocks.
  webview.bind("_ok", () => lib.symbols.webview_terminate(handle));

  // The page sends how much the client area must change, not a height: set_size
  // sizes the whole frame, so a delta cancels out the titlebar unmeasured.
  webview.bind("_grow", (delta: number) =>
    (webview.size = { width: WIDTH, height: Math.min(START_HEIGHT + delta, MAX_HEIGHT), hint: SizeHint.FIXED }),
  );

  webview.setHTML(/*html*/ `<!DOCTYPE html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100% }
  /* scrollable, so #fit may exceed the window and still report its own height */
  body {
    overflow-y: scroll; background: #f5f5f7; color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  #fit { padding: 20px }   /* height:auto -- shrink-wraps content; this is what we measure */
  h2 { font-size: 16px; margin-bottom: 12px; color: #ff3b30 }
  p { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin-bottom: 16px }
  /* block + auto margin, not float: a float wouldn't count toward #fit's height */
  button {
    display: block; margin-left: auto; padding: 8px 20px; border-radius: 6px;
    font-size: 14px; cursor: pointer; border: 1px solid #d2d2d7; background: #0071e3; color: #fff;
  }
  button:hover { filter: brightness(0.95) }
</style>
<div id="fit">
  <h2>slack-desktop-mcp failed to start</h2>
  <p>${escapeHtml(message)}</p>
  <button onclick="_ok()">OK</button>
</div>
<script>
  onkeydown = e => { if (e.key === "Enter" || e.key === "Escape") _ok() };
  // After fonts settle, or reflow moves the height right after we snap to it.
  (document.fonts?.ready ?? Promise.resolve()).then(() => requestAnimationFrame(() => {
    const box = document.getElementById("fit").getBoundingClientRect();
    const delta = Math.ceil(box.height) - innerHeight;
    if (delta) _grow(delta);
  }));
</script>`);

  webview.run();
}
