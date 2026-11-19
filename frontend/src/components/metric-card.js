export function renderMetricCard({ id, label, value, icon, tone, detail }) {
  return `
    <section class="card cafe-card dashboard-metric dashboard-tone--${tone}" aria-labelledby="${id}">
      <div class="card-body">
        <div class="dashboard-metric__heading">
          <h2 id="${id}">${label}</h2>
          <span class="dashboard-metric__icon">
            <i data-lucide="${icon}" aria-hidden="true"></i>
          </span>
        </div>
        <p class="dashboard-metric__value${value === null ? ' dashboard-metric__value--unavailable' : ''}">
          ${value === null ? 'Unavailable' : value}
        </p>
        <p class="cafe-muted cafe-supporting mb-0">${detail}</p>
      </div>
    </section>
  `
}
