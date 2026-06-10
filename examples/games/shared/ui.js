/**
 * Shared result overlay for the kiosk flow. Unlike the games' transient
 * `.center-msg` (which is pointer-events:none), this overlay is interactive and
 * offers "もう一度 / メニュー" so a visitor never gets stuck on a finished game.
 */

export function showResult(stagebox, { title, sub = "", badge = "", retryLabel = "もう一度", onRetry, onMenu }) {
  clearResult(stagebox);
  const ov = document.createElement("div");
  ov.className = "result";
  ov.innerHTML = `
    <div class="result-card">
      ${badge ? `<div class="result-badge">${badge}</div>` : ""}
      <div class="result-title">${title}</div>
      ${sub ? `<div class="result-sub">${sub}</div>` : ""}
      <div class="result-actions"></div>
    </div>`;
  const actions = ov.querySelector(".result-actions");
  const retry = document.createElement("button");
  retry.className = "primary";
  retry.textContent = retryLabel;
  retry.onclick = () => {
    clearResult(stagebox);
    onRetry && onRetry();
  };
  const menu = document.createElement("button");
  menu.textContent = "メニュー";
  menu.onclick = () => onMenu && onMenu();
  actions.append(retry, menu);
  // keyboard: Enter/Space activate the focused Retry button natively; Esc = Menu
  ov.tabIndex = -1;
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      menu.onclick();
    }
  });
  stagebox.appendChild(ov);
  retry.focus();
  return ov;
}

export function clearResult(stagebox) {
  const e = stagebox.querySelector(".result");
  if (e) e.remove();
}
