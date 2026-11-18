export function renderPreviewForm() {
  return `
    <p class="cafe-supporting cafe-muted mb-3">Try the controls with fictional values. Nothing is saved.</p>
    <form id="preview-form" novalidate>
      <div class="row g-3">
        <div class="col-12 col-sm-6">
          <label for="sample-name" class="form-label">Sample item name</label>
          <input class="form-control" id="sample-name" type="text" placeholder="e.g. House blend"
            maxlength="60" aria-describedby="sample-name-error" required>
          <span class="invalid-feedback" id="sample-name-error">Enter a sample item name.</span>
        </div>
        <div class="col-12 col-sm-6">
          <label for="sample-category" class="form-label">Sample category</label>
          <select class="form-select" id="sample-category" aria-describedby="sample-category-error" required>
            <option value="">Choose a category</option>
            <option value="Ingredients">Ingredients</option>
            <option value="Packaging">Packaging</option>
          </select>
          <span class="invalid-feedback" id="sample-category-error">Choose a sample category.</span>
        </div>
      </div>
      <div class="d-flex flex-wrap gap-2 mt-4">
        <button class="btn btn-primary" type="submit">
          <i data-lucide="plus" aria-hidden="true"></i>
          Preview fields
        </button>
        <button class="btn btn-outline-primary" type="reset">Reset</button>
        <button class="btn btn-primary" type="button" disabled>Save unavailable</button>
      </div>
      <p class="preview-result cafe-supporting mb-0" id="preview-result" role="status"></p>
    </form>
  `
}

export function initializePreviewForm(form) {
  const itemName = form.querySelector('#sample-name')
  const category = form.querySelector('#sample-category')
  const result = form.querySelector('#preview-result')

  const fields = [itemName, category]

  function validate(field) {
    const valid = Boolean(field.value.trim())
    field.classList.toggle('is-invalid', !valid)
    if (valid) {
      field.removeAttribute('aria-invalid')
    } else {
      field.setAttribute('aria-invalid', 'true')
    }
    return valid
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()

    const invalidFields = fields.filter((field) => !validate(field))
    if (invalidFields.length) {
      result.textContent = 'Check the highlighted sample fields.'
      invalidFields[0].focus()
      return
    }

    result.textContent = `Preview: ${itemName.value.trim()} · ${category.value}. Nothing was saved.`
  })

  form.addEventListener('input', (event) => {
    result.textContent = ''
    if (fields.includes(event.target) && event.target.classList.contains('is-invalid')) {
      validate(event.target)
    }
  })

  form.addEventListener('reset', () => {
    for (const field of fields) {
      field.classList.remove('is-invalid')
      field.removeAttribute('aria-invalid')
    }
    result.textContent = 'Sample fields cleared.'
  })
}
