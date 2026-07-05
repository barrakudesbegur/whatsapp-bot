/** kb/*.md files are imported as plain text (see wrangler.jsonc `rules`). */
declare module "*.md" {
  const text: string;
  export default text;
}
