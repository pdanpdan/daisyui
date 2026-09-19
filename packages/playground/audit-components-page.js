/**
 * Audit: find modifier variants that are demonstrated on fewer elements than the docs demo the
 * same modifier in. A pattern modifier (`collapse-arrow`, `step-primary`, `tab-active`) shown on
 * a single element while its page documents it inside a multi element pattern is misleading.
 *
 * Usage: bun audit-components-page.js
 */
import {
  SKIPPED_CATEGORIES,
  SKIPPED_FROM_AUDIT,
  allFences,
  components,
  elements,
  matches,
  pickFence,
  specsByComponent,
} from "./generate-components-page.js"

/** How many elements a variant's classes would land on inside a demo. */
const targetCount = (fence, classes, specs) =>
  elements(fence).filter((element) =>
    classes.some((name) => {
      const spec = specs.get(name)
      return spec && matches(element, spec)
    }),
  ).length

const rows = []
for (const component of components) {
  const specs = specsByComponent.get(component.dir)
  for (const [category, items] of Object.entries(component.cats)) {
    if (SKIPPED_CATEGORIES.includes(category) || SKIPPED_FROM_AUDIT.includes(category)) continue
    for (const item of items) {
      const spec = specs.get(item.class)
      if (!spec?.observed?.length) continue
      // Compare against the demos that actually use the class, not every demo of the component.
      const documented = Math.max(
        0,
        ...spec.observed.map((fence) => targetCount(fence, [item.class], specs)),
      )
      const chosen = pickFence(component, [item.class], specs, allFences, true)
      if (!chosen) continue
      const rendered = targetCount(chosen, [item.class], specs)
      if (rendered < documented && documented > 1) {
        rows.push({ component: component.dir, category, class: item.class, rendered, documented })
      }
    }
  }
}

console.log(`${rows.length} variants are demonstrated on fewer elements than the docs\n`)
for (const row of rows) {
  console.log(
    `${row.component.padEnd(14)} ${row.category.padEnd(10)} ${row.class.padEnd(24)} rendered=${row.rendered} documented=${row.documented}`,
  )
}
