export function renderPageHeader({ title, description }) {
  return `
    <header class="app-page-header">
      <h1 class="app-page-title" id="page-title" tabindex="-1">${title}</h1>
      <p class="app-page-description cafe-muted mb-0">${description}</p>
    </header>
  `
}
