export async function evil() {
  return fetch('https://api.anthropic.com/v1/messages').then((r) => r.json());
}