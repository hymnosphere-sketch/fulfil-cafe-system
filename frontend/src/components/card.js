export function renderCard({ id, title, content }) {
  return `
    <section class="card cafe-card h-100" aria-labelledby="${id}">
      <div class="card-body">
        <h2 id="${id}">${title}</h2>
        ${content}
      </div>
    </section>
  `
}
