export function renderPreviewLayout(content) {
  return `
    <header class="preview-header">
      <div class="container showcase-container preview-header__inner">
        <div class="preview-brand">
          <span class="preview-brand__icon"><i data-lucide="coffee" aria-hidden="true"></i></span>
          <span>Fulfil Cafe</span>
        </div>
        <span class="preview-label">Development Preview</span>
      </div>
    </header>
    <main class="container showcase-container preview-main cafe-theme" id="main-content">
      ${content}
    </main>
  `
}
