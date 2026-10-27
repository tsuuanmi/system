/** A CSS section as a template: its values (a token block, another section) are inserted as text. */
export function css(strings: TemplateStringsArray, ...values: readonly string[]): string {
  return strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '')
}

/** The stylesheet: its sections, one per line break, as the server serves it (same sections, same bytes). */
export function stylesheet(...sections: readonly string[]): string {
  return `\n${sections.join('\n')}\n`
}
