// RULE 3: EXEMPT — read-only OAuth usage endpoint, fixed-cost
export async function quota() {
  return fetch('https://api.anthropic.com/api/oauth/usage');
}