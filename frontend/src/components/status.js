export function renderBadge({ tone, icon, label }) {
  return `
    <span class="badge cafe-badge cafe-tone--${tone}">
      <i data-lucide="${icon}" aria-hidden="true"></i>
      ${label}
    </span>
  `
}

export function renderMessage({ tone, icon, title, message }) {
  return `
    <div class="cafe-message cafe-tone--${tone}">
      <i data-lucide="${icon}" aria-hidden="true"></i>
      <div>
        <strong>${title}</strong>
        <div>${message}</div>
      </div>
    </div>
  `
}
