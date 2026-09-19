/**
 * Generates `src/pages/components/index.html`: a structured visual check page for every
 * daisyUI component, in every documented modifier combination, on any theme, LTR and RTL.
 *
 * The registry (classes, categories, descriptions) and all demo markup are read from the
 * docs component pages, so the page cannot drift from the docs. Matrix variants are
 * synthesized by rewriting the classes of a documented demo; the element a modifier belongs
 * to is learned from the docs markup, so modifiers that live on a child element
 * (`step-primary` on `li.step`, `chat-bubble-primary` on `.chat-bubble`) land on that child.
 *
 * Usage: bun generate-components-page.js
 *
 * `bun audit-components-page.js` reports variants that end up demonstrated on fewer elements
 * than the demo that documents them, which is how a misleading matrix cell is spotted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import themeOrder from "../daisyui/functions/themeOrder.js"

const here = dirname(fileURLToPath(import.meta.url))
const docsComponentsRoot = resolve(here, "../docs/src/routes/(routes)/components")
const outputFile = resolve(here, "src/pages/components/index.html")

/** Caps that keep a single page readable and small enough to render quickly. */
const MAX_COMBINATION_ITEMS = 120
const MAX_RELATED_DEMOS = 24
const MAX_RELATED_BYTES = 12000
/** Combinations per component that get the other component's size/color variants. */
const MAX_AXIS_COMBOS = 4
/**
 * Variants of some components only show their effect in a demo that forces the state visible:
 * a tooltip is hover only unless `tooltip-open` is set, so its variants are checked in the
 * demos that contain that class rather than in a hover only demo.
 */
const VISIBILITY_COMPANIONS = { tooltip: "tooltip-open" }
/** Modifier categories that get their own matrix axis. */
const STRUCTURAL_CATEGORIES = ["component", "part"]
const SKIPPED_CATEGORIES = ["component", "part", "variant"]
/** Categories the audit ignores: a single element is the right presentation for them. */
const SKIPPED_FROM_AUDIT = ["size", "color", "style", "placement"]
const SIZE_CATEGORIES = ["size"]
const COLOR_CATEGORIES = ["color"]

/* -------------------------------------------------------------------------- *
 * docs parsing
 * -------------------------------------------------------------------------- */

/** `classnames:` frontmatter -> `{ category: [{ class, desc }] }`, order preserved. */
const parseClassnames = (frontmatter) => {
  const start = frontmatter.indexOf("classnames:")
  if (start < 0) return {}

  const categories = {}
  let current
  for (const line of frontmatter.slice(start + "classnames:".length).split("\n")) {
    const category = line.match(/^ {2}([A-Za-z_]+):\s*$/)
    if (category) {
      current = category[1]
      categories[current] = []
      continue
    }
    const item = line.match(/^\s+-\s*class:\s*'?([^'\n]+?)'?\s*$/)
    if (item && current) {
      categories[current].push({ class: item[1].trim(), desc: "" })
      continue
    }
    const desc = line.match(/^\s+desc:\s*(.+?)\s*$/)
    if (desc && current && categories[current].length) {
      categories[current][categories[current].length - 1].desc = desc[1]
    }
  }
  return Object.fromEntries(Object.entries(categories).filter(([, items]) => items.length))
}

/** Demos of a component page: every `###`/`####` section with its HTML fences. */
const parseDemos = (body) => {
  const headings = [...body.matchAll(/^#{3,4} (.+)$/gm)]
  return headings
    .map((heading, index) => {
      const chunk = body.slice(
        heading.index + heading[0].length,
        index + 1 < headings.length ? headings[index + 1].index : body.length,
      )
      const fences = [...chunk.matchAll(/```([a-zA-Z]*)[ \t]*\n([\s\S]*?)\n```/g)]
        .filter(
          ([, language, markup]) =>
            (language === "" || language === "html") && /^\s*</.test(markup),
        )
        .map(([, , markup]) => markup.replace(/\$\$/g, "").trim())
      return { title: heading[1].replace(/^~/, "").trim(), fences }
    })
    .filter((demo) => demo.fences.length)
}

const loadComponents = () =>
  readdirSync(docsComponentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => existsSync(resolve(docsComponentsRoot, dir, "+page.md")))
    .sort()
    .map((dir) => {
      const markdown = readFileSync(resolve(docsComponentsRoot, dir, "+page.md"), "utf8")
      const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/)
      const header = frontmatter[1]
      const title = header.match(/^title:\s*(.+)$/m)?.[1].trim() ?? dir
      const desc = header.match(/^desc:\s*(.+)$/m)?.[1].trim() ?? ""
      const cats = parseClassnames(header)
      const demos = parseDemos(markdown.slice(frontmatter[0].length))
      return {
        dir,
        title,
        desc,
        cats,
        demos,
        fences: [...new Set(demos.flatMap((demo) => demo.fences))],
        classes: new Set(
          Object.values(cats)
            .flat()
            .map((item) => item.class),
        ),
      }
    })

/* -------------------------------------------------------------------------- *
 * markup helpers
 * -------------------------------------------------------------------------- */

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])
const CLASS_ATTRIBUTE = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g

/**
 * Every element of a markup string with its nesting depth. Only top level elements contain
 * one another, which is what tells a root class apart from a class of a child element.
 */
const elements = (html) => {
  const found = []
  const stack = []
  TAG.lastIndex = 0
  let match
  while ((match = TAG.exec(html))) {
    const [, closing, tag, attributes, selfClosing] = match
    const name = tag.toLowerCase()
    if (closing) {
      const open = stack.lastIndexOf(name)
      if (open >= 0) stack.length = open
      continue
    }
    const classAttribute = attributes.match(CLASS_ATTRIBUTE)
    found.push({
      tag: name,
      depth: stack.length,
      classes: classAttribute
        ? (classAttribute[2] ?? classAttribute[3]).split(/\s+/).filter(Boolean)
        : [],
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      classAttribute: classAttribute?.[0] ?? null,
    })
    if (!VOID_ELEMENTS.has(name) && !selfClosing) stack.push(name)
  }
  return found
}

/** Markup with the class attribute of matched elements rewritten. */
const rewriteClasses = (html, transform) => {
  const parts = []
  let cursor = 0
  for (const element of elements(html)) {
    const next = transform(element)
    if (!next) continue
    const classAttribute = `class="${next.join(" ")}"`
    const raw = element.classAttribute
      ? element.raw.replace(element.classAttribute, classAttribute)
      : element.raw.replace(/^<([a-zA-Z][\w:-]*)/, `<$1 ${classAttribute}`)
    parts.push(html.slice(cursor, element.start), raw)
    cursor = element.end
  }
  return parts.length ? parts.concat(html.slice(cursor)).join("") : html
}

/** Demos are shown without their scripts: they assume page level state that does not exist here. */
const stripScripts = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()

/** Checkboxes documented with an indeterminate state, wired up by the playground `main.js`. */
const markIndeterminate = (html) =>
  /indeterminate/i.test(html)
    ? html.replace(
        /<input\b(?![^>]*\bdata-indeterminate\b)([^>]*type="checkbox")/g,
        "<input data-indeterminate$1",
      )
    : html

/**
 * Makes ids and their references unique inside a fragment, so repeated demos on one page
 * (labels, radio groups, dialogs, popovers, anchor names, inline handlers) stay independent.
 */
const uniqueIds = (html, suffix) => {
  const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((match) => match[1]))
  if (!ids.size) return html

  const rename = (name) => (ids.has(name) ? `${name}__${suffix}` : name)
  return html
    .replace(/\bid\s*=\s*"([^"]+)"/g, (_, name) => `id="${name}__${suffix}"`)
    .replace(
      /\b(for|popovertarget|list|form|aria-controls|aria-labelledby|aria-describedby)\s*=\s*"([^"]+)"/g,
      (_, attribute, name) => `${attribute}="${rename(name)}"`,
    )
    .replace(/\bhref\s*=\s*"#([^"]+)"/g, (_, name) => `href="#${rename(name)}"`)
    .replace(/\bname\s*=\s*"([^"]+)"/g, (_, name) => `name="${name}__${suffix}"`)
    .replace(/\b(anchor-name|position-anchor)\s*:\s*(--[\w-]+)/g, (match, property, value) =>
      ids.has(value.slice(2)) ? `${property}:${value}__${suffix}` : match,
    )
    .replace(
      /getElementById\(\s*(['"])([^'"]+)\1\s*\)/g,
      (_, quote, name) => `getElementById(${quote}${rename(name)}${quote})`,
    )
    .replace(/\b([A-Za-z_][\w$]*)\.(showModal|show|close)\(\)/g, (match, name, method) =>
      ids.has(name) ? `document.getElementById('${rename(name)}').${method}()` : match,
    )
}

/* -------------------------------------------------------------------------- *
 * modifier targets
 * -------------------------------------------------------------------------- */

const matches = (element, spec) =>
  (!spec.top || element.depth === 0) && spec.classes.every((name) => element.classes.includes(name))

/**
 * Learns, for every variant, which element it belongs to and which demos document it:
 * `{ top, classes, observed }` matches elements that have `classes` and, when `top` is set,
 * sit at the top level of a demo.
 *
 * Resolution is per documentation page, so a page that documents a class shows it in its own
 * pattern (the accordion page shows an accordion of collapses, not a single collapse):
 *
 * 1. structural classes (`card`, `step`, `tabs`) identify their own element,
 * 2. else the element the *own* page applies the class to,
 * 3. else the element another page applies it to (`collapse-open` is only demoed on the
 *    collapse page, where it needs the focusable collapse rather than the `<details>` one),
 * 4. else the target of the longest class it extends (`step-success` from `step`),
 * 5. else no spec: the class is shown as the documented demo that uses it.
 */
const buildMatchSpecs = (components) => {
  const owner = new Map()
  /** Structural targets are shared: `step` anchors `step` on the steps page and everywhere else. */
  const structural = new Map()
  for (const component of components) {
    for (const [category, items] of Object.entries(component.cats)) {
      for (const item of items) {
        owner.set(item.class, { component, category })
        if (STRUCTURAL_CATEGORIES.includes(category)) {
          structural.set(item.class, { top: false, classes: [item.class] })
        }
      }
    }
  }

  /** Every place a documented class is used: which page, on which element, with which anchor. */
  const observations = new Map()
  for (const component of components) {
    for (const fence of component.fences) {
      for (const element of elements(fence)) {
        for (const name of element.classes) {
          if (!owner.has(name)) continue
          const anchor = element.classes
            .filter((other) => owner.has(other) && other !== name)
            .sort()
          const list = observations.get(name) ?? []
          list.push({
            from: component.dir,
            top: element.depth === 0,
            classes: anchor,
            usable: element.depth === 0 || anchor.length > 0,
            fence,
          })
          observations.set(name, list)
        }
      }
    }
  }

  const best = (candidates) =>
    candidates
      .filter((candidate) => candidate.usable)
      .sort((a, b) => a.classes.length - b.classes.length || a.fence.length - b.fence.length)[0]

  // Structural classes are their own anchor, and every demo that uses them can host a variant.
  const structuralFences = new Map()
  for (const [name] of structural) {
    structuralFences.set(name, [
      ...new Set((observations.get(name) ?? []).map((observation) => observation.fence)),
    ])
    structural.set(name, { top: false, classes: [name], observed: structuralFences.get(name) })
  }

  const fencesOf = (observations_) => [...new Set(observations_.map((o) => o.fence))]

  /** The longest class a name extends, e.g. `step-success` -> `step`. */
  const inheritedSpec = (name, specs) => {
    const parts = name.split("-")
    for (let end = parts.length - 1; end > 0; end--) {
      const prefix = parts.slice(0, end).join("-")
      const found = specs.get(prefix) ?? structural.get(prefix)
      if (found) return found
    }
    return null
  }

  const specsByComponent = new Map(components.map((component) => [component.dir, new Map()]))
  for (const component of components) {
    const specs = specsByComponent.get(component.dir)
    for (const [category, items] of Object.entries(component.cats)) {
      if (STRUCTURAL_CATEGORIES.includes(category)) {
        for (const item of items) specs.set(item.class, structural.get(item.class))
        continue
      }
      for (const item of items) {
        const name = item.class
        const all = observations.get(name) ?? []
        const own = all.filter((observation) => observation.from === component.dir)
        const chosenOwn = best(own)
        // Documented on this page, but only on an element that cannot be located again
        // (`dock-active` on a bare `<button>`): the documented demo is shown instead.
        if (!chosenOwn && own.length) continue

        const inherited = chosenOwn ? null : inheritedSpec(name, specs)
        const elsewhere = chosenOwn || inherited ? null : best(all)
        const target = chosenOwn ?? inherited ?? elsewhere
        if (!target) continue

        specs.set(name, {
          top: target.top,
          classes: target.classes,
          // The demos that show this class, so a variant can be rendered in one of them.
          observed: fencesOf((chosenOwn ? own : all).filter((observation) => observation.usable)),
        })
      }
    }
  }

  return { specsByComponent, owner }
}

/* -------------------------------------------------------------------------- *
 * variant rendering
 * -------------------------------------------------------------------------- */

/**
 * Smallest documented demo that can host a variant, preferring the demo that documents the
 * modifier itself: some modifiers only work in the markup the docs pair them with
 * (`collapse-open` needs the focusable collapse, not the `<details>` one).
 */
const pickFence = (component, classes, specs, allFences, preferObserved) => {
  const hosts = (fence) =>
    classes.every((name) => elements(fence).some((element) => matches(element, specs.get(name))))
  const shortestFirst = (fences) => [...fences].sort((a, b) => a.length - b.length)
  // Among the demos that document a class, prefer one that is not viewport dependent and that
  // exercises more of the component: `tooltip-start` is only comparable in the demo that also
  // shows the other placements, and there the tooltip is forced open instead of hover only.
  // Widen a class's demos with the demos that force the state visible, when it has none.
  const companion = VISIBILITY_COMPANIONS[component.dir]
  const withVisibleState = (fences) => {
    const shows = (fence) => elements(fence).some((element) => element.classes.includes(companion))
    if (!companion || fences.some(shows)) return fences
    return [
      ...new Set([
        ...fences,
        ...component.fences.filter(shows),
        ...allFences.filter((entry) => shows(entry.fence)).map((entry) => entry.fence),
      ]),
    ]
  }
  const ranked = (fences) =>
    [...fences]
      .map((fence) => {
        const tokens = new Set(elements(fence).flatMap((element) => element.classes))
        return {
          fence,
          responsive: [...tokens].some(
            (name) => name.includes(":") && component.classes.has(baseClass(name)),
          ),
          documented: [...tokens].filter((name) => component.classes.has(name)).length,
        }
      })
      .sort(
        (a, b) =>
          Number(a.responsive) - Number(b.responsive) ||
          b.documented - a.documented ||
          a.fence.length - b.fence.length,
      )
      .map((entry) => entry.fence)
  const observed = classes.map((name) => specs.get(name)?.observed ?? [])
  const locallyDocumented = classes.every((name) =>
    (specs.get(name)?.observed ?? []).some((fence) => component.fences.includes(fence)),
  )

  const tiers = []
  if (preferObserved && classes.length > 0 && observed.every((fences) => fences.length)) {
    tiers.push(
      ranked(
        withVisibleState(
          observed[0].filter((fence) => observed.every((fences) => fences.includes(fence))),
        ),
      ),
    )
  }
  // A variant that mixes a modifier this page never demos (only another page does) is rendered
  // in that page's markup, where the modifier is known to have an effect.
  if (preferObserved && !locallyDocumented) {
    tiers.push(ranked(withVisibleState([...new Set(observed.flat())])))
  }
  tiers.push(shortestFirst(component.fences))
  if (preferObserved) tiers.push(ranked(withVisibleState([...new Set(observed.flat())])))
  tiers.push(shortestFirst(allFences.map((entry) => entry.fence)))

  for (const tier of tiers) {
    const found = tier.find(hosts)
    if (found) return found
  }
  return ""
}

/** The class a token applies to, dropping responsive/state prefixes (`md:tooltip-center`). */
const baseClass = (name) => {
  const separator = name.lastIndexOf(":")
  return separator < 0 ? name : name.slice(separator + 1)
}

/**
 * Demo markup with `classes` applied to their elements and `stripped` classes removed,
 * including their responsive variants, which would otherwise override the applied class.
 */
const renderVariant = (fence, classes, stripped, specs) => {
  const adds = classes.map((name) => ({ name, spec: specs.get(name) })).filter((add) => add.spec)
  return rewriteClasses(fence, (element) => {
    const kept = element.classes.filter(
      (name) => !stripped.has(name) && !stripped.has(baseClass(name)),
    )
    const added = adds.filter((add) => matches(element, add.spec)).map((add) => add.name)
    return added.length || kept.length !== element.classes.length ? [...kept, ...added] : null
  })
}

/** True when `name` is applied as a class in `html`. */
const hasClass = (html, name) =>
  new RegExp(`(^|["\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["\\s]|$)`).test(html)

/**
 * Combinations where a component shares an element with another component that has sizes or
 * colors of its own (`validator` on `input`, `join-item` on `btn`): those axis classes are the
 * variants worth checking for the combination, since the component itself has none.
 */
const buildAxisCombos = (components, owner) => {
  const combos = new Map(components.map((component) => [component.dir, []]))
  for (const component of components) {
    const seen = new Set()
    for (const demo of component.demos) {
      for (const fence of demo.fences) {
        for (const element of elements(fence)) {
          if (!element.classes.some((name) => component.classes.has(name))) continue
          for (const name of element.classes) {
            const other = owner.get(name)?.component
            if (!other || other.dir === component.dir || seen.has(other.dir)) continue
            const categoryAxes = [
              (other.cats.size ?? []).length && !(component.cats.size ?? []).length ? "size" : null,
              (other.cats.color ?? []).length && !(component.cats.color ?? []).length
                ? "color"
                : null,
            ].filter(Boolean)
            if (!categoryAxes.length) continue
            // The demo where both components sit on the same element.
            const shared = component.fences
              .filter((candidate) =>
                elements(candidate).some(
                  (el) =>
                    el.classes.includes(name) &&
                    el.classes.some((own) => component.classes.has(own)),
                ),
              )
              .sort((a, b) => a.length - b.length)[0]
            if (!shared) continue
            seen.add(other.dir)
            combos.get(component.dir).push({ other, fence: shared, axes: categoryAxes, demo })
          }
        }
      }
    }
  }
  return combos
}

/* -------------------------------------------------------------------------- *
 * page building
 * -------------------------------------------------------------------------- */

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Demos reference dozens of remote images: load them as they scroll into view. */
const lazyImages = (html) => html.replace(/<img\b(?![^>]*\bloading=)/g, '<img loading="lazy"')

/** Cells whose demo has a `<form>` get a reset control next to their label. */
const demoCell = (label, html, cellClasses, kind = "") => {
  const labelMarkup = escapeHtml(label)
  const caption = /<form[\s>]/i.test(html)
    ? `<figcaption class="flex items-center justify-between gap-2 border-b border-base-300 bg-base-200 px-3 py-1 font-mono text-xs opacity-70">
              <span class="break-all">${labelMarkup}</span>
              <button type="button" class="btn btn-xs btn-ghost" data-reset-form>reset</button>
            </figcaption>`
    : `<figcaption class="border-b border-base-300 bg-base-200 px-3 py-1 font-mono text-xs break-all opacity-70">${labelMarkup}</figcaption>`

  return `
          <figure class="rounded-box border border-base-300 bg-base-100"${kind ? ` data-${kind}=""` : ""}>
            ${caption}
            <div class="relative flex min-h-32 w-full flex-wrap items-center justify-center gap-4 p-6 ${cellClasses}">${lazyImages(html)}</div>
          </figure>`
}

const demoGrid = (cells) =>
  `<div class="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">${cells.join("")}</div>`

/**
 * The variants the matrix spot checks: `sm` and `lg`, plus a single color (secondary, else
 * primary, else whatever the component documents first). The docs examples show the full sets.
 */
const matrixSizes = (items) => {
  const picked = items.filter((item) => /-(sm|lg)$/.test(item.class))
  return picked.length ? picked : items.slice(0, 1)
}
const matrixColors = (items) => {
  const picked =
    items.find((item) => item.class.endsWith("-secondary")) ??
    items.find((item) => item.class.endsWith("-primary")) ??
    items[0]
  return picked ? [picked] : []
}

const buildComponentSection = (component, context) => {
  const { specsByComponent, owner, cellClasses, demosUsing, allFences, axisCombos } = context
  const specs = specsByComponent.get(component.dir)
  const { cats } = component
  const cellClassesFor = cellClasses[component.dir] ?? DEFAULT_CELL_CLASSES
  const sizeItems = matrixSizes(cats.size ?? [])
  const colorItems = matrixColors(cats.color ?? [])
  const modifierCategories = Object.entries(cats).filter(
    ([category]) =>
      !SKIPPED_CATEGORIES.includes(category) &&
      !SIZE_CATEGORIES.includes(category) &&
      !COLOR_CATEGORIES.includes(category),
  )
  const unrenderable = new Set()
  let suffix = 0

  const classesOf = (category) => (cats[category] ?? []).map((item) => item.class)

  /**
   * A variant cell: `classes` are applied, everything of `categories` is removed first.
   * `hint` picks the demo (a baseline cell uses the demo of its group's first variant, so a
   * row of modifiers is rendered in the same markup and can be compared).
   */
  const variantCell = (label, classes, description, categories, hint = classes) => {
    if (classes.some((name) => !specs.has(name))) {
      return contextCell(classes[classes.length - 1], description)
    }
    const stripped = new Set(categories.flatMap(classesOf))
    // Sizes and colors are structure independent; every other modifier is shown in the demo
    // the docs pair it with, because some of them only work in that markup.
    const preferObserved = categories.some(
      (category) => !SIZE_CATEGORIES.includes(category) && !COLOR_CATEGORIES.includes(category),
    )
    const fence = pickFence(component, hint, specs, allFences, preferObserved)
    const html = fence && uniqueIds(renderVariant(fence, classes, stripped, specs), `c${suffix++}`)
    // A class that could not be placed would render a demo that lies about it: show the docs instead.
    if (!html || classes.some((name) => !hasClass(html, name))) {
      return contextCell(classes[classes.length - 1], description)
    }
    return demoCell(
      description ? `${label} — ${description}` : label,
      markIndeterminate(html),
      cellClassesFor,
      "variant",
    )
  }

  const categoryOf = (name) => owner.get(name)?.category

  /** A documented demo that shows a class whose target element cannot be located. */
  const contextCell = (name, description) => {
    const own = [...component.fences]
      .filter((fence) => hasClass(fence, name))
      .sort((a, b) => a.length - b.length)[0]
    const fence =
      own ??
      allFences
        .filter((entry) => hasClass(entry.fence, name))
        .sort((a, b) => a.fence.length - b.fence.length)[0]?.fence
    if (!fence) {
      unrenderable.add(name)
      return ""
    }
    const markup = stripScripts(fence)
    if (!markup || !hasClass(markup, name)) {
      unrenderable.add(name)
      return ""
    }
    return demoCell(
      description ? `${name} — ${description}` : name,
      uniqueIds(markup, `x${suffix++}`),
      cellClassesFor,
      "context",
    )
  }

  const sections = []
  const section = (title, cells) => {
    if (!cells.length) return
    sections.push(
      `<h3 class="mt-8 mb-3 text-lg font-semibold">${escapeHtml(title)}</h3>${demoGrid(cells)}`,
    )
  }

  /** The first variant of a group that has a target, used to pick the group's demo. */
  const hintFor = (items) => {
    const first = items.find((item) => specs.has(item.class))
    return first ? [first.class] : []
  }

  if (sizeItems.length) {
    section("Sizes", [
      variantCell("default", [], "", ["size"], hintFor(sizeItems)),
      ...sizeItems.map((item) => variantCell(item.class, [item.class], item.desc, ["size"])),
    ])
  }

  if (colorItems.length) {
    section("Colors", [
      variantCell("default", [], "", ["color"], hintFor(colorItems)),
      ...colorItems.map((item) => variantCell(item.class, [item.class], item.desc, ["color"])),
    ])
  }

  if (sizeItems.length && colorItems.length) {
    const cells = []
    for (const size of sizeItems) {
      for (const color of colorItems) {
        cells.push(
          variantCell(`${size.class} ${color.class}`, [size.class, color.class], "", [
            "size",
            "color",
          ]),
        )
      }
    }
    section("Sizes × colors", cells)
  }

  for (const [category, items] of modifierCategories) {
    section(`Modifiers — ${category}`, [
      variantCell("default", [], "", [category], hintFor(items)),
      ...items.map((item) =>
        specs.has(item.class)
          ? variantCell(item.class, [item.class], item.desc, [category])
          : contextCell(item.class, item.desc),
      ),
    ])
  }

  if (modifierCategories.length > 1) {
    const combinations = []
    const walk = (start, chosen) => {
      if (chosen.length >= 2) combinations.push([...chosen])
      for (let index = start; index < modifierCategories.length; index++) {
        for (const item of modifierCategories[index][1]) {
          if (!specs.has(item.class)) continue
          chosen.push(item.class)
          walk(index + 1, chosen)
          chosen.pop()
        }
      }
    }
    walk(0, [])

    const capped = combinations.slice(0, MAX_COMBINATION_ITEMS)
    const cells = capped.map((classes) =>
      variantCell(classes.join(" "), classes, "", [...new Set(classes.map(categoryOf))]),
    )
    section(
      `Modifier combinations${combinations.length > capped.length ? ` (first ${capped.length} of ${combinations.length})` : ""}`,
      cells,
    )
  }

  // Combinations that share an element with a component that has sizes or colors of its own.
  for (const { other, fence, axes } of (axisCombos.get(component.dir) ?? []).slice(
    0,
    MAX_AXIS_COMBOS,
  )) {
    const otherSpecs = specsByComponent.get(other.dir)
    // The other component's classes are applied by name here, so a `select` nested inside a
    // form still matches when its own page only demos top level selects.
    const axisSpecs = new Map(
      [...otherSpecs].map(([name, spec]) => [name, { ...spec, top: false }]),
    )
    const stripAxis = new Set(
      [...(other.cats.size ?? []), ...(other.cats.color ?? [])].map((item) => item.class),
    )
    const combinationCell = (label, classes) => {
      if (!classes.every((name) => otherSpecs.has(name))) return ""
      const html = uniqueIds(renderVariant(fence, classes, stripAxis, axisSpecs), `x${suffix++}`)
      if (!html || classes.some((name) => !hasClass(html, name))) return ""
      return demoCell(label, markIndeterminate(html), cellClassesFor, "combination")
    }
    const title = `${component.title.replace(/\s*\(.*\)$/, "")} with ${other.title}`

    for (const axis of axes) {
      const items =
        axis === "size" ? matrixSizes(other.cats.size ?? []) : matrixColors(other.cats.color ?? [])
      const cells = [combinationCell("default", [])]
        .concat(
          items.map((item) =>
            combinationCell(item.desc ? `${item.class} — ${item.desc}` : item.class, [item.class]),
          ),
        )
        .filter(Boolean)
      // A group that only has the baseline means the classes could not be placed: skip it.
      if (cells.length > 1) section(`${title} — ${axis === "size" ? "sizes" : "colors"}`, cells)
    }
  }

  // The documented examples, exactly as the docs ship them.
  const seen = new Set()
  const exampleCells = []
  for (const demo of component.demos) {
    for (const fence of demo.fences) {
      const markup = stripScripts(fence)
      if (!markup || seen.has(markup)) continue
      seen.add(markup)
      exampleCells.push(
        demoCell(demo.title, uniqueIds(markIndeterminate(markup), `e${suffix++}`), cellClassesFor),
      )
    }
  }
  section("Documented examples", exampleCells)

  // Demos of other component pages that use this component.
  const relatedCells = []
  const relatedTitles = []
  for (const { component: other, demo, fence } of demosUsing.get(component.dir) ?? []) {
    const markup = stripScripts(fence)
    if (!markup || seen.has(markup)) continue
    if (relatedCells.length >= MAX_RELATED_DEMOS) break
    if (relatedCells.reduce((bytes, cell) => bytes + cell.length, 0) > MAX_RELATED_BYTES) break
    seen.add(markup)
    if (!relatedTitles.includes(other.title)) relatedTitles.push(other.title)
    relatedCells.push(
      demoCell(
        `${other.title} — ${demo.title}`,
        uniqueIds(markup, `r${suffix++}`),
        cellClasses[other.dir] ?? DEFAULT_CELL_CLASSES,
      ),
    )
  }
  section(`Used together with: ${relatedTitles.join(", ")}`, relatedCells)

  const chips = Object.entries(cats)
    .filter(([category]) => !SKIPPED_CATEGORIES.includes(category))
    .map(
      ([category, items]) =>
        `<span class="mr-3 inline-block"><span class="opacity-50">${escapeHtml(category)}</span> ${items
          .map(
            (item) =>
              `<code class="rounded-sm bg-base-300/60 px-1">${escapeHtml(item.class)}</code>`,
          )
          .join(" ")}</span>`,
    )
    .join("")

  const note = unrenderable.size
    ? `<p class="mt-2 text-xs opacity-60">No documentation demo to check: ${[...unrenderable]
        .map((name) => `<code>${escapeHtml(name)}</code>`)
        .join(", ")}</p>`
    : ""

  return `
      <details id="${component.dir}" class="scroll-mt-48 rounded-box border border-base-300 bg-base-200/40 pb-6" open>
        <summary class="cursor-pointer p-4 text-2xl font-bold">
          ${escapeHtml(component.title)}
          <span class="font-mono text-sm font-normal opacity-50">${escapeHtml(component.dir)}</span>
        </summary>
        <div class="px-4">
          <p class="text-sm opacity-70">${escapeHtml(component.desc)}</p>
          <p class="mt-2 text-xs leading-6">${chips}</p>
          ${note}
          ${sections.join("")}
        </div>
      </details>`
}

const buildPage = (components, context) => {
  const toc = components
    .map(
      (component) =>
        `<a class="btn btn-xs" href="#${component.dir}">${escapeHtml(component.title)}</a>`,
    )
    .join("")

  const themeButtons = themeOrder
    .map(
      (theme) =>
        `<input type="radio" name="theme-buttons" class="btn btn-sm theme-controller join-item" aria-label="${theme}" value="${theme}"${theme === "light" ? " checked" : ""} />`,
    )
    .join("")

  const sections = components.map((component) => buildComponentSection(component, context)).join("")

  return `<!doctype html>
<html lang="en" dir="ltr" data-theme="light" class="overflow-x-clip">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>daisyUI playground — components visual check</title>
    <link rel="stylesheet" href="/main.css" />
    <style>
      /* These demos are shown in their open state (modal-open, open drawer). daisyUI locks the
         page scroll while an overlay is open, which would make this page unscrollable, so the
         lock is dropped for those states. Dialogs a click opens for real still lock the page. */
      :root:has(.modal.modal-open, .drawer-toggle:checked) {
        --page-scroll-lock: initial !important;
      }
    </style>
    <script type="module" src="/main.js"></script>
    <!-- Cally web component, used by the calendar demos -->
    <script type="module" src="https://unpkg.com/cally"></script>
  </head>
  <body class="p-4 overflow-x-clip">
    <span id="top" class="block scroll-mt-4"></span>
    <header dir="ltr" class="sticky top-4 z-50 mb-4 flex flex-col gap-2 rounded-box bg-base-100/95 p-3 shadow-sm backdrop-blur">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold opacity-60">Theme</span>
        <div class="join flex flex-wrap">${themeButtons}</div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold opacity-60">Direction</span>
        <div class="join">
          <input type="radio" name="page-direction" class="btn btn-sm join-item" aria-label="LTR" value="ltr" checked />
          <input type="radio" name="page-direction" class="btn btn-sm join-item" aria-label="RTL" value="rtl" />
        </div>
        <div class="join">
          <label class="input input-sm join-item w-56">
            <span class="opacity-50">filter</span>
            <input type="search" class="grow" placeholder="component name / class" />
          </label>
          <button type="button" class="btn btn-sm join-item" data-filter-clear>all</button>
        </div>
        <span class="text-xs opacity-60" data-filter-count>${components.length} components</span>
        <a class="btn btn-sm" href="#top">↑ top</a>
      </div>
    </header>

    <p class="mb-2 text-xs opacity-60">
      Generated from the docs component pages by
      <code class="rounded-sm bg-base-300/60 px-1">packages/playground/generate-components-page.js</code>
      — run <code class="rounded-sm bg-base-300/60 px-1">bun generate-components-page.js</code> to refresh it.
    </p>

    <nav class="mb-6 flex flex-wrap gap-1">${toc}</nav>

    <main class="flex flex-col gap-6">${sections}
    </main>

    <script>
      for (const input of document.querySelectorAll('input[name="page-direction"]')) {
        input.addEventListener("change", () => {
          if (input.checked) document.documentElement.dir = input.value
        })
      }

      const total = ${components.length}
      const filter = document.querySelector('header input[type="search"]')
      const clear = document.querySelector("header [data-filter-clear]")
      const count = document.querySelector("header [data-filter-count]")
      const sections = [...document.querySelectorAll("main > details")]

      const applyFilter = () => {
        const needle = filter.value.trim().toLowerCase()
        let shown = 0
        for (const section of sections) {
          const match = needle === "" || section.textContent.toLowerCase().includes(needle)
          section.hidden = !match
          if (match) shown++
        }
        count.textContent = needle === "" ? \`\${total} components\` : \`\${shown} of \${total} components\`
        clear.disabled = needle === ""
      }

      const resetFilter = () => {
        filter.value = ""
        applyFilter()
        filter.focus()
      }

      filter.addEventListener("input", applyFilter)
      filter.addEventListener("keydown", (event) => {
        if (event.key === "Escape") resetFilter()
      })
      clear.addEventListener("click", resetFilter)
      applyFilter()

      // Demos are self contained: submitting one must not navigate away from this page.
      // Forms with method="dialog" keep their default action, which closes the dialog.
      document.addEventListener(
        "submit",
        (event) => {
          const form = event.target
          if (form.closest("main") && form.method !== "dialog") event.preventDefault()
        },
        true,
      )

      // Cells that contain a form get a reset control, so a filled or invalid demo can be cleared.
      document.addEventListener("click", (event) => {
        const button = event.target.closest("[data-reset-form]")
        if (!button) return
        const cell = button.closest("figure")
        for (const form of cell.querySelectorAll("form")) form.reset()
        for (const control of cell.querySelectorAll("input, select, textarea")) {
          if (control.type === "checkbox" || control.type === "radio") {
            control.checked = control.defaultChecked
          } else {
            control.value = control.defaultValue
          }
          control.blur()
        }
      })
    </script>
  </body>
</html>
`
}

/* -------------------------------------------------------------------------- *
 * entry
 * -------------------------------------------------------------------------- */

const components = loadComponents()
const { specsByComponent, owner } = buildMatchSpecs(components)

/** Every documented demo on the site, used when a class is only demoed on another page. */
const allFences = components.flatMap((component) =>
  component.fences.map((fence) => ({ fence, component })),
)

/**
 * Demos of every component that use another component, so each component can show the
 * combinations daisyUI is actually used in (`input` inside `validator`, `btn` inside `join`).
 */
/** Combinations worth checking with the sizes/colors of the other component. */
const axisCombos = buildAxisCombos(components, owner)

const demosUsing = new Map(components.map((component) => [component.dir, []]))
for (const component of components) {
  for (const demo of component.demos) {
    for (const fence of demo.fences) {
      const used = new Set()
      for (const element of elements(fence)) {
        for (const name of element.classes) {
          const found = owner.get(name)
          if (found && found.component.dir !== component.dir) used.add(found.component.dir)
        }
      }
      for (const dir of used) {
        demosUsing.get(dir).push({ component, demo, fence })
      }
    }
  }
}

/**
 * Space and overflow each component needs around its demo: fixed elements and open dialogs are
 * contained by their cell, popups keep overflowing, full width layouts get a scroll container.
 */
const cellClasses = {
  carousel: "w-full overflow-x-auto",
  diff: "w-full overflow-x-auto",
  dock: "h-64 overflow-hidden [contain:paint]",
  drawer: "h-96 overflow-hidden [contain:paint]",
  dropdown: "min-h-64 items-start pb-40 overflow-visible",
  fab: "h-64 overflow-hidden [contain:paint]",
  footer: "w-full overflow-x-auto",
  hero: "w-full overflow-x-auto",
  list: "w-full overflow-x-auto",
  megamenu: "min-h-96 items-start pb-40 overflow-visible",
  menu: "min-h-48 items-start pb-32 overflow-visible",
  modal: "h-96 overflow-hidden [contain:paint]",
  navbar: "w-full overflow-x-auto",
  stat: "w-full overflow-x-auto",
  steps: "w-full overflow-x-auto",
  table: "w-full overflow-x-auto",
  timeline: "w-full overflow-x-auto",
  toast: "h-64 overflow-hidden [contain:paint]",
  tooltip: "p-12 overflow-visible",
}
/** Wide demos are clipped, not scrolled, unless the component asks for a scroll container. */
const DEFAULT_CELL_CLASSES = "overflow-x-clip"

if (import.meta.main) {
  const page = buildPage(components, {
    specsByComponent,
    owner,
    allFences,
    cellClasses,
    demosUsing,
    axisCombos,
  })
  mkdirSync(dirname(outputFile), { recursive: true })
  writeFileSync(outputFile, page)
  console.log(
    `Wrote ${outputFile} (${(page.length / 1024).toFixed(0)} KB, ${components.length} components)`,
  )
}

export {
  COLOR_CATEGORIES,
  axisCombos,
  SIZE_CATEGORIES,
  SKIPPED_CATEGORIES,
  SKIPPED_FROM_AUDIT,
  STRUCTURAL_CATEGORIES,
  allFences,
  buildComponentSection,
  buildMatchSpecs,
  buildPage,
  cellClasses,
  components,
  demosUsing,
  elements,
  loadComponents,
  matches,
  owner,
  pickFence,
  renderVariant,
  specsByComponent,
  stripScripts,
  uniqueIds,
}
