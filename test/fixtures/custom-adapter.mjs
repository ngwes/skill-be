// A user adapter: its default export answers with the model id and the prompt.
export default async function customAdapter(prompt, ctx) {
  return `custom ${ctx.settings.id}: ${prompt}`;
}
